/**
 * The machine that does the work.
 *
 * CodeRook records runs; it does not execute them. This is the other half of
 * that arrangement: a small agent somebody installs on a machine they already
 * own, which asks a project whether there is anything to do, does it there,
 * and reports back. The service never holds a sandbox, never writes an egress
 * policy, and never pays for compute — and the button on the Actions screen
 * still does a real thing.
 *
 * It is the same shape as a GitHub self-hosted runner, deliberately, because
 * that is the arrangement people already understand.
 *
 * The trust boundary is worth stating plainly, and the agent states it out
 * loud at startup: anybody who can set a workflow's command on this project
 * can run that command on this machine, as whoever started the agent. That is
 * not a flaw to be fixed, it is what a runner is — but it should be a
 * decision somebody made rather than one they discovered.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {redactRunOutput, RunOutputStream, credentialArtifactPath, artifactContainsSecret} from "../../cbx/src/shared/run_output.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, mkdir, chmod, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";

import { Downloader } from "../../cbx/src/core/download.js";
import { clientHeaders } from "../../cbx/src/core/identify.js";
import { apiOrigin, credentials, loadToken } from "./config.js";
import { RunProgress } from "./progress.js";

export type ClaimedRun = {
  workspaceInput?: boolean;
  artifactsAllowed?: boolean;
  runId: string;
  number: number;
  workflowId: string;
  workflowName: string;
  command: string | null;
  workingDirectory: string | null;
  versionId: string | null;
  versionSequence: number | null;
  attempts: number;
  /** Paths this run is expected to hand back, relative to the checkout. */
  artifactPaths?: string[];
  /** CODEROOK_* variables, matrix values and the project's secrets, handed to the command. */
  environment?: Record<string, string>;
  /** Which of those are secret: their values are replaced by *** before anything is shown or sent. */
  secretNames?: string[];
  /** The workflow's own time limit, when it set one. */
  timeoutMinutes?: number | null;
};

/** Replace each secret's value with ***, longest first. */
export function maskSecrets(text: string, secrets: string[]): string {
  return redactRunOutput(text, secrets);
}

/** How often to tell the service the machine is still working. */
const HEARTBEAT_MS = 30_000;

/** How often log lines are sent up while a command is running. */
const FLUSH_MS = 2_000;

/**
 * The same deadline the rest of the client uses, so nothing here can wait for
 * ever on a request the service never answers.
 */
const REQUEST_DEADLINE_MS = 180_000;

async function call<T>(
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in. Run: cbx sign-in");
  const response = await fetch(`${apiOrigin()}${route}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...clientHeaders(),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `${route} failed (${response.status})`) as Error & { code?: string };
    error.code = body?.error?.code;
    throw error;
  }
  return body as T;
}

/**
 * Send output up in batches rather than a line at a time.
 *
 * A build that prints ten thousand lines would otherwise be ten thousand
 * requests, and the run would spend longer reporting than working. Lines are
 * numbered from where the last batch ended, so what arrives is in the order
 * it was printed even when a flush is slow.
 */
class LogShipper {
  private pending: Array<{ line: string; stream: "stdout" | "stderr" }> = [];
  private sent = 0;
  private failed = false;

  constructor(
    private readonly repositoryId: string,
    private readonly runId: string,
    /*
      Said through the progress display rather than straight to the console:
      a line written while the status line is on screen lands on top of it.
    */
    private readonly say: (line: string) => void = console.error,
  ) {}

  add(chunk: string, stream: "stdout" | "stderr"): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line !== "") this.pending.push({ line: line.slice(0, 2000), stream });
    }
  }

  async flush(): Promise<void> {
    if (!this.pending.length || this.failed) return;
    const batch = this.pending.splice(0, 500);
    try {
      await call(
        `/v1/repositories/${this.repositoryId}/runs/${this.runId}/logs`,
        {
          method: "POST",
          body: {
            lines: batch.map((entry, at) => ({
              line: entry.line,
              stream: entry.stream,
              lineNumber: this.sent + at,
            })),
          },
        },
      );
      this.sent += batch.length;
    } catch (error) {
      /*
        Losing the log is not a reason to lose the run. The verdict still
        matters — and it is the thing somebody is waiting for — so a shipper
        that cannot deliver says so once and stops trying.
      */
      this.failed = true;
      this.say(`  (log upload stopped: ${errorText(error)})`);
    }
  }
}

/**
 * The environment a workflow command gets, minus this machine's own keys.
 *
 * Running somebody's command on your machine is the deal a runner makes, and
 * it is stated at every startup. Handing them the token that machine signs in
 * with is not: `cbx runner` reads CODEROOK_TOKEN from the environment so
 * automated runs can supply it, and every child process inherited it. A
 * workflow set to `env` by anyone with write access printed it straight into
 * the run log, which read access is enough to see — so a collaborator could
 * walk off with the account of whoever was hosting the runner.
 *
 * Only platform and toolchain variables are inherited. The command gets a
 * temporary HOME, npm configuration and cache inside the job folder. This
 * prevents accidental inheritance; a native runner is still trusted code on
 * its host, not a filesystem or network sandbox.
 */
export function withoutCredentials(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = { ...source };
  for (const name of Object.keys(safe)) {
    if (!/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LANG|LC_[A-Z_]+|TERM|COLORTERM|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|JAVA_HOME|DOTNET_ROOT|CARGO_HOME|RUSTUP_HOME|GOROOT|GOPATH)$/i.test(name)) {
      delete safe[name];
    }
  }
  return safe;
}

/**
 * Where the command is allowed to run.
 *
 * `path.join` resolves `..`, so a working directory of `../../..` walks out
 * of the throwaway folder and runs the command somewhere on this machine
 * instead — the project's own directory, a home folder, anywhere. The service
 * refuses to store one now, but a row written before it did is still a row,
 * and this is the side that actually starts the process.
 *
 * Refused rather than clamped. Silently running somewhere other than where a
 * workflow asked would be its own kind of surprise.
 */
function insideWorkspace(workspace: string, requested: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `This workflow asks to run outside its own folder (${requested})`,
    );
  }
  return resolved;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ask for work. Null means the queue is empty, which is the usual answer. */
export async function claim(
  repositoryId: string,
  runner: string,
  version: string,
  labels: string[],
): Promise<ClaimedRun | null> {
  const body = await call<{ run: ClaimedRun | null }>(
    `/v1/repositories/${repositoryId}/runs/claim`,
    {
      method: "POST",
      body: {
        runner,
        platform: `${os.platform()}-${os.arch()}`,
        version,
        labels,
      },
    },
  );
  return body.run ?? null;
}

/**
 * What this machine answers to when nobody says.
 *
 * The platform it actually is, because that is what somebody means when they
 * write a workflow that has to produce a Windows installer — and getting it
 * wrong is not a crash, it is a build that runs on the wrong operating system
 * and fails for a reason nobody asked about.
 */
export function defaultLabels(): string[] {
  const platform = os.platform();
  if (platform === "win32") return ["windows"];
  if (platform === "darwin") return ["macos"];
  return ["linux"];
}

/**
 * Hand back what the run built.
 *
 * The bytes go up through the object store's own route, which verifies the
 * digest on arrival — the same route versions use, rather than a second way
 * to put bytes in that would be a second place to get that wrong. Then the
 * run is told which object was which file.
 *
 * Failing to upload does not fail the run. The verdict is what somebody is
 * waiting for, and losing a build that passed because the network went odd
 * afterwards would be a worse answer than a pass with a missing download.
 */
export async function uploadArtifacts(
  repositoryId: string,
  runId: string,
  workspace: string,
  patterns: string[],
  say: (line: string) => void,
  secrets: string[] = [],
): Promise<number> {
  const wanted = await collectArtifacts(workspace, patterns);
  let kept = 0;
  for (const file of wanted) {
    try {
      if (credentialArtifactPath(file.relative)) { say("Skipped an authentication/configuration artifact"); continue; }
      const bytes = await readFile(file.absolute);
      if (artifactContainsSecret(bytes, secrets)) { say("Skipped an artifact containing credential material"); continue; }
      const digest = createHash("sha256").update(bytes).digest("hex");
      const token = await loadToken();
      const stored = await fetch(
        `${apiOrigin()}/v1/repositories/${repositoryId}` +
          `/objects/${digest}?kind=chunk&role=chunk`,
        {
          method: "PUT",
          signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
            ...clientHeaders(),
          },
          body: bytes,
        },
      );
      if (!stored.ok) throw new Error(`upload failed (${stored.status})`);
      const object = (await stored.json()) as { objectId: string };
      await call(`/v1/repositories/${repositoryId}/runs/${runId}/artifacts`, {
        method: "POST",
        body: {
          path: file.relative,
          objectId: object.objectId,
          sizeBytes: bytes.byteLength,
        },
      });
      kept += 1;
      say(`Kept ${file.relative} (${bytes.byteLength} bytes)`);
    } catch (error) {
      say(`Could not keep ${file.relative}: ${errorText(error)}`);
    }
  }
  return kept;
}

/**
 * Find the files a workflow asked to keep.
 *
 * Patterns are shell-ish rather than a full glob library: a directory keeps
 * everything under it, and a `*` matches within one path segment. That covers
 * `dist/`, `build/*.exe` and `out/**` — which is what people write — without
 * taking a dependency to parse the rest.
 */
async function collectArtifacts(
  workspace: string,
  patterns: string[],
): Promise<Array<{ absolute: string; relative: string }>> {
  const everything: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const at = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(at);
      else if (entry.isFile()) everything.push(at);
    }
  };
  await walk(workspace);

  const found = new Map<string, { absolute: string; relative: string }>();
  for (const raw of patterns) {
    const pattern = normalisePattern(raw);
    if (!pattern) continue;
    const matcher = patternMatcher(pattern);
    for (const absolute of everything) {
      const relative = path.relative(workspace, absolute).split(path.sep).join("/");
      if (matcher(relative)) found.set(relative, { absolute, relative });
    }
  }
  return [...found.values()];
}

/** Tidy a pattern, and refuse one that tries to leave the checkout. */
function normalisePattern(raw: string): string | null {
  const cleaned = raw.split("\\").join("/").replace(/^\/+/, "").trim();
  if (!cleaned) return null;
  return cleaned.split("/").includes("..") ? null : cleaned;
}

/**
 * Match one path against one pattern.
 *
 * `dist` keeps everything under it, `*` matches within a segment and `**`
 * across them. Built by escaping the pattern and then putting the wildcards
 * back, rather than by escaping around them — doing it the other way is how
 * a dot in `*.exe` quietly becomes "any character".
 */
function patternMatcher(pattern: string): (path: string) => boolean {
  const expression = new RegExp(
    `^${pattern
      .split("/")
      .map((part) =>
        part === "**"
          ? "[SPAN]"
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split("\\*").join("[^/]*"),
      )
      .join("/")
      .split("[SPAN]")
      .join(".*")}$`,
  );
  return (candidate) =>
    expression.test(candidate) || candidate.startsWith(`${pattern}/`);
}


/**
 * Carry out one run, from a fresh copy of the version to a verdict.
 *
 * The version is materialised into a throwaway directory rather than into
 * anybody's working folder: a run that wrote over the checkout somebody was
 * editing would be a way to lose work, and a run that reused the last one's
 * directory would let one job's leftovers decide the next job's result.
 */
export async function performRun(
  repositoryId: string,
  run: ClaimedRun,
  runner: string,
): Promise<{ status: "passed" | "failed" | "cancelled"; summary: string }> {
  const progress = new RunProgress();
  /* Set when somebody cancels the run on CodeRook: the work stops now rather than when it ends. */
  let cancelled = false;
  /* Set when the workflow's time limit passes on this machine. */
  let timedOut = false;
  let limitTimer: NodeJS.Timeout | undefined;
  const secrets = (run.secretNames ?? [])
    .map((name) => run.environment?.[name] ?? "")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let child: ReturnType<typeof spawn> | null = null;
  const stopChild = () => {
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      /* The command runs through a shell; the whole tree goes, not only the shell. */
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  };
  const logs = new LogShipper(repositoryId, run.runId, (line) =>
    progress.say(maskSecrets(line, secrets)),
  );
  const started = Date.now();
  const workspace = await mkdtemp(path.join(tmpdir(), "coderook-run-"));
  let beating: NodeJS.Timeout | undefined;
  let flushing: NodeJS.Timeout | undefined;

  try {
    beating = setInterval(() => {
      void call(`/v1/repositories/${repositoryId}/runs/${run.runId}/heartbeat`, {
        method: "POST",
        body: { runner },
      }).catch((error: { code?: string }) => {
        /*
          Cancelled: end the work now. A lost lease otherwise means the service
          has given this run to somebody else, and the local process is doing
          work nobody will accept; the report at the end changes nothing, and
          the run that matters is the one the other machine is doing.
        */
        if (error?.code === "run_cancelled" && !cancelled) {
          cancelled = true;
          logs.add("Cancelled on CodeRook. Stopping.", "stderr");
          stopChild();
        }
      });
    }, HEARTBEAT_MS);

    if (run.workspaceInput) {
      const input=await call<{workspaceId:string;revision:number;command:string;workingDirectory:string|null;artifactPaths:string[];files:Array<{index:number;path:string;size:number;sha256:string;executable:boolean}>}>(`/v1/repositories/${repositoryId}/workspace-runs/${run.runId}/input`);
      run.command=input.command;run.workingDirectory=input.workingDirectory;run.artifactPaths=input.artifactPaths;
      logs.add(`Fetching ${input.files.length} selected files from frozen workspace revision ${input.revision}…`,'stdout');
      const token=await loadToken();
      for(const file of input.files){
        if(cancelled)throw new Error('Cancelled while fetching workspace input');
        if(!/^[a-f0-9]{64}$/.test(file.sha256??''))throw new Error(`The frozen file ${file.path} has no verified content digest`);
        const destination=insideWorkspace(workspace,file.path);await mkdir(path.dirname(destination),{recursive:true});
        const response=await fetch(`${apiOrigin()}/v1/repositories/${repositoryId}/workspace-runs/${run.runId}/input/${file.index}`,{headers:{authorization:`Bearer ${token}`,...clientHeaders()},signal:AbortSignal.timeout(REQUEST_DEADLINE_MS)});
        if(!response.ok||!response.body)throw new Error(`Could not fetch frozen workspace file ${file.path} (${response.status})`);
        const hash=createHash('sha256');let bytes=0;
        const verify=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>file.size){callback(new Error('Frozen workspace file exceeds its declared size'));return;}hash.update(chunk);callback(null,chunk);}});
        await pipeline(Readable.fromWeb(response.body as never),verify,createWriteStream(destination));
        if(bytes!==file.size||hash.digest('hex')!==file.sha256)throw new Error(`Frozen content verification failed for ${file.path}; credential-bearing source must use separately configured credentials`);
        if(file.executable&&process.platform!=='win32')await chmod(destination,0o755);
      }
      logs.add('Selected workspace inputs verified.','stdout');
    } else if (run.versionId) {
      logs.add(`Fetching v${run.versionSequence ?? "?"}…`, "stdout");
      /*
        The one phase that knows its own size. The version says how many files
        it holds, so this gets a real proportion rather than a spinner
        pretending to measure something.
      */
      progress.step(`Fetching v${run.versionSequence ?? "?"}`, "", 0);
      const downloader = new Downloader(credentials);
      const got = await downloader.run(
        repositoryId,
        run.versionId,
        workspace,
        (state) =>
          progress.advance(
            `${state.files}/${state.totalFiles} files`,
            state.totalFiles ? state.files / state.totalFiles : null,
          ),
        null,
        "replace",
      );
      logs.add(`Fetched ${got.files} files.`, "stdout");
    } else {
      logs.add("This run has no version; running in an empty folder.", "stdout");
    }
    await logs.flush();

    const command = run.command?.trim();
    if (!command) {
      return { status: "failed", summary: "This workflow has no command" };
    }

    const directory = run.workingDirectory
      ? insideWorkspace(workspace, run.workingDirectory)
      : workspace;

    progress.step("Running", maskSecrets(command, secrets));
    // npm and other tools must not automatically reuse the runner owner's login files.
    const home = path.join(workspace, ".run-home");
    await mkdir(home, {recursive:true});
    const temporary = path.join(home, "tmp");
    await mkdir(temporary, {recursive:true});
    const emptyConfig = path.join(home, "empty.npmrc");
    await writeFile(emptyConfig, "", {mode:0o600});
    flushing = setInterval(() => void logs.flush(), FLUSH_MS);

    const code = await new Promise<number>((settle) => {
      /*
        Through a shell, because the command is one shell line and people
        write them expecting a shell — pipes, `&&`, an environment variable.
        Which shell is the platform's own, so a Windows machine reads it the
        way a Windows user wrote it.
      */
      if (cancelled) {
        settle(1);
        return;
      }
      child = spawn(command, {
        cwd: directory,
        shell: true,
        /* Its own process group off Windows, so cancelling can stop everything it started. */
        detached: process.platform !== "win32",
        env: {
          ...withoutCredentials(process.env),
          ...(run.environment ?? {}),
          HOME: home,
          USERPROFILE: home,
          TEMP: temporary,
          TMP: temporary,
          TMPDIR: temporary,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          NPM_CONFIG_USERCONFIG: emptyConfig,
          NPM_CONFIG_GLOBALCONFIG: emptyConfig,
          NPM_CONFIG_CACHE: path.join(home, ".npm-cache"),
          CI: "true",
          CODEROOK_RUN: String(run.number),
          CODEROOK_VERSION: run.versionSequence
            ? `v${run.versionSequence}`
            : "",
        },
      });
      /*
        Shipped and shown, not one or the other. The service needs the log so
        a failed run can be read later; the person watching needs it so they
        can tell a slow build from a stuck one.
      */
      const decoders = {stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8")};
      const protectedStreams = {stdout: new RunOutputStream(secrets), stderr: new RunOutputStream(secrets)};
      const show = (text: string, stream: "stdout" | "stderr") => { if (text) { logs.add(text, stream); progress.say(text); } };
      const tee = (chunk: Buffer, stream: "stdout" | "stderr") => show(protectedStreams[stream].push(decoders[stream].write(chunk)), stream);
      const finishOutput = () => { for (const stream of ["stdout", "stderr"] as const) {
        show(protectedStreams[stream].push(decoders[stream].end()) + protectedStreams[stream].end(), stream);
      }};
      child.stdout?.on("data", (chunk: Buffer) => tee(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => tee(chunk, "stderr"));
      child.on("error", (error) => {
        logs.add(maskSecrets(errorText(error), secrets), "stderr");
        settle(1);
      });
      child.on("close", (status) => { finishOutput(); settle(status ?? 1); });
      if (run.timeoutMinutes) {
        limitTimer = setTimeout(() => {
          timedOut = true;
          logs.add(`Stopped: past this workflow's time limit of ${run.timeoutMinutes} minutes.`, "stderr");
          stopChild();
        }, run.timeoutMinutes * 60_000);
      }
    });
    if (limitTimer) clearTimeout(limitTimer);

    /*
      What it built, before the folder goes.

      Kept whether the run passed or failed: a failed build often produces the
      very log or partial output somebody needs to work out why, and throwing
      that away is exactly when they would have wanted it.
    */
    if (run.artifactPaths?.length && (run.artifactsAllowed ?? !run.secretNames?.length)) {
      progress.step("Keeping what it built");
      const kept = await uploadArtifacts(
        repositoryId,
        run.runId,
        workspace,
        run.artifactPaths,
        (line) => {
          logs.add(maskSecrets(line, secrets), "stdout");
          progress.say(maskSecrets(line, secrets));
        },
        secrets,
      );
      if (!kept) {
        logs.add("Nothing matched the paths this workflow keeps.", "stdout");
      }
    }

    if (run.artifactPaths?.length && !(run.artifactsAllowed ?? !run.secretNames?.length)) logs.add("Artifacts disabled for this credential-capable run; use a separate credential-free build job.", "stdout");
    await logs.flush();
    const seconds = Math.round((Date.now() - started) / 1000);
    if (timedOut) return { status: "failed", summary: `Stopped after its time limit of ${run.timeoutMinutes} minutes` };
    if (cancelled) return { status: "cancelled", summary: `Cancelled after ${seconds}s` };
    return code === 0
      ? { status: "passed", summary: `Passed in ${seconds}s` }
      : { status: "failed", summary: `Exited ${code} after ${seconds}s` };
  } catch (error) {
    const safeError = maskSecrets(errorText(error), secrets);
    logs.add(safeError, "stderr");
    await logs.flush();
    return { status: "failed", summary: safeError.slice(0, 200) };
  } finally {
    /*
      Before anything else. A spinner still repainting while the last flush
      goes out would overwrite the verdict the caller is about to print.
    */
    progress.done();
    if (limitTimer) clearTimeout(limitTimer);
    if (beating) clearInterval(beating);
    if (flushing) clearInterval(flushing);
    await logs.flush();
    await rm(workspace, { recursive: true, force: true, maxRetries:3, retryDelay:100 }).catch(async () => {
      const summary="Runner cleanup failed. Stop this runner and remove its temporary job folder before processing more credential-bearing work.";
      // Report a final failure before stopping the runner, rather than leaving
      // a completed publish queued for a lease-expiry retry.
      await report(repositoryId,run.runId,{status:"failed",summary},Date.now()-started).catch(()=>undefined);
      throw new Error(summary);
    });
  }
}

/** Say how it went. */
export async function report(
  repositoryId: string,
  runId: string,
  verdict: { status: "passed" | "failed" | "cancelled"; summary: string },
  durationMs: number,
): Promise<void> {
  await call(`/v1/repositories/${repositoryId}/runs/${runId}`, {
    method: "PATCH",
    body: { ...verdict, durationMs },
  });
}
