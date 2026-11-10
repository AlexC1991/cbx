/**
 * The native byte engine (cbx/engine, Rust), when there is one.
 *
 * The engine does the same byte work as the TypeScript here — hashing, cutting
 * big files, framing and packing objects — with the same results: the same
 * SHA-256 names, the same chunk cuts, the same "cbx-local 1" store. It is only
 * faster, because it reads, hashes and compresses on every core at once. The
 * cross-tests in cbx/engine/compat compare the two on real folders.
 *
 * It is optional. Every caller keeps its own TypeScript path and uses it
 * whenever this returns null: no engine for this platform, CBX_ENGINE=off, a
 * failed run, or an answer that does not look right. A run that fails once is
 * not tried again in the same process, so a broken binary costs one attempt.
 *
 * Where it is looked for:
 *   CBX_ENGINE=<path>   that binary ("off" turns the engine off)
 *   engine-bin/<platform>-<arch>/cbx-engine[.exe] in this package or a folder above it
 */
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants as fsConstants, existsSync } from "node:fs";
import path from "node:path";

/** The engine's command protocol this code speaks; `cbx-engine version` reports its own. */
const PROTOCOL = 1;

/** Below this much work, starting a process costs more than it saves. */
export const ENGINE_MIN_FILES = 24;
export const ENGINE_MIN_BYTES = 32 * 1024 * 1024;
/** Below this many files a folder is walked faster here than by starting the engine. */
export const ENGINE_SCAN_MIN_FILES = 400;

let located: string | null | undefined;
let broken: string | null = null;

function binaryName(): string {
  return process.platform === "win32" ? "cbx-engine.exe" : "cbx-engine";
}

/*
  Whether the binary may be run, making it so when it can be.

  A package packed on Windows carries no execute bit, so on macOS and Linux the
  engine arrives as a plain file. Setting the bit is all it needs; where the
  install folder is not ours to change, the TypeScript path is used instead.
*/
function runnable(candidate: string): boolean {
  if (process.platform === "win32") return true;
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    try {
      chmodSync(candidate, 0o755);
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** Where the engine is, or null when there is none to use. */
export function enginePath(): string | null {
  if (located !== undefined) return located;
  const chosen = process.env.CBX_ENGINE?.trim();
  if (chosen === "off" || chosen === "0" || chosen === "false") return (located = null);
  if (chosen) return (located = existsSync(chosen) ? chosen : null);
  /* CommonJS here; in an ES module build __dirname is not defined and only CBX_ENGINE applies. */
  let directory: string | null = typeof __dirname === "string" ? __dirname : null;
  const wanted = path.join("engine-bin", `${process.platform}-${process.arch}`, binaryName());
  for (let depth = 0; directory && depth < 8; depth += 1) {
    const candidate = path.join(directory, wanted);
    if (existsSync(candidate)) return (located = runnable(candidate) ? candidate : null);
    const parent = path.dirname(directory);
    directory = parent === directory ? null : parent;
  }
  return (located = null);
}

/** Why the engine is not being used, for diagnostics; null when it is available. */
export function engineProblem(): string | null {
  if (broken) return broken;
  return enginePath() ? null : "no engine for this platform";
}

/*
  Whether the engine should open and read files itself (store, measure), as
  opposed to only walking folders (scan).

  Not on Windows, for now. With real-time protection on, which is nearly
  everyone, Windows Security scans each new file when the unsigned engine
  opens it and barely slows Node, a signed and widely known program. On a
  fresh copy of 8,525 files the engine took 13–16 s to store what Node read
  and stored in 3 s; with protection off the engine took 0.5 s. Until the
  engine is signed, Windows reads files here and the engine keeps the folder
  walk, which only lists and stats and is not scanned. CBX_ENGINE_READS=on
  turns engine reads back on.
*/
function engineMayRead(): boolean {
  if (process.env.CBX_ENGINE_READS === "on") return true;
  if (process.env.CBX_ENGINE_READS === "off") return false;
  return process.platform !== "win32";
}

/** Whether a batch of this size is worth handing to the engine to read. */
export function worthTheEngine(files: number, bytes: number): boolean {
  if (enginePath() === null || broken || files === 0) return false;
  /* CBX_ENGINE_ALWAYS=1 sends every batch, however small, so tests can run everything through it. */
  if (process.env.CBX_ENGINE_ALWAYS === "1") return true;
  if (!engineMayRead()) return false;
  return files >= ENGINE_MIN_FILES || bytes >= ENGINE_MIN_BYTES;
}

type Run = { stdout: string; stderr: string; code: number | null };

function run(
  args: string[],
  input: string | null,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<Run> {
  const binary = enginePath()!;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ stdout: "", stderr: String(error), code: -1 });
      return;
    }
    /* Cancelling the operation stops the engine with it. */
    const stop = () => child.kill();
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop, { once: true });
    child.on("close", () => signal?.removeEventListener("abort", stop));
    const out: Buffer[] = [];
    let err = "";
    let partial = "";
    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => {
      const text = partial + data.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (onLine && line.startsWith("{")) onLine(line);
        else err += `${line}\n`;
      }
    });
    child.on("error", (error) => resolve({ stdout: "", stderr: String(error), code: -1 }));
    child.on("close", (code) => resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: err + partial, code }));
    child.stdin.on("error", () => {
      /* The engine exited before reading; its exit code says why. */
    });
    child.stdin.end(input ?? "");
  });
}

/*
  Every answer carries the protocol it speaks, so an engine from another
  release is caught on its first answer without a separate process to ask.
*/
function usable(): boolean {
  return Boolean(enginePath()) && !broken;
}

async function ask<T>(
  args: string[],
  input: unknown,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<T | null> {
  if (!usable()) return null;
  const answer = await run(args, JSON.stringify(input), onLine, signal);
  /* Stopped on purpose is not a broken engine; the caller sees its own cancellation. */
  if (signal?.aborted) return null;
  if (answer.code !== 0) {
    broken = `cbx-engine ${args[0]} failed: ${answer.stderr.trim().slice(0, 300)}`;
    return null;
  }
  let parsed: (T & { protocol?: number }) | null = null;
  try {
    parsed = JSON.parse(answer.stdout) as T & { protocol?: number };
  } catch {
    broken = `cbx-engine ${args[0]} gave an answer that is not JSON`;
    return null;
  }
  if (parsed?.protocol !== PROTOCOL) {
    broken = `engine at ${enginePath()} does not speak protocol ${PROTOCOL}`;
    return null;
  }
  return parsed;
}

type ProgressLine = { done: number; total: number; path: string };
const progressFrom = (report?: (done: number, total: number, file: string) => void) =>
  report
    ? (line: string) => {
        try {
          const parsed = JSON.parse(line) as ProgressLine;
          report(parsed.done, parsed.total, parsed.path);
        } catch {
          /* A line that is not progress; ignored. */
        }
      }
    : undefined;

export type EngineStored = { path: string; size?: number; sha256?: string; chunks?: string[]; error?: string };

/**
 * Store files into a "cbx-local 1" object store, as `storeFile` does for each.
 *
 * Null when the engine is not available or the run failed; a file the engine
 * could not read comes back with `error`, for the caller's own path to retry
 * and report. Objects are on disk (packs flushed) when this returns.
 */
export async function engineStore(
  objectsDirectory: string,
  root: string,
  files: Array<{ path: string; size: number }>,
  progress?: (done: number, total: number, file: string) => void,
  signal?: AbortSignal,
): Promise<Map<string, EngineStored> | null> {
  const answer = await ask<{ files: EngineStored[] }>(
    ["store", objectsDirectory, root, ...(progress ? ["--progress"] : [])],
    files,
    progressFrom(progress),
    signal,
  );
  if (!answer || !Array.isArray(answer.files) || answer.files.length !== files.length) {
    if (answer) broken = "cbx-engine store answered for the wrong number of files";
    return null;
  }
  const byPath = new Map<string, EngineStored>();
  for (const one of answer.files) byPath.set(one.path, one);
  return byPath;
}

/**
 * `mtimeMs` is the file's modification time as Node's Stats.mtimeMs gives it, taken before and
 * after reading and the same both times — so an answer whose size and mtimeMs match a later stat
 * describes the bytes on disk. A file that changed while it was read comes back with `error`.
 */
export type EngineMeasured = {
  path: string;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
  lines?: number;
  binary?: boolean;
  error?: string;
};

/**
 * Digests of many files at once; with `count`, also lines and whether the file is binary,
 * worked out as `measure` in core/worktree.ts does.
 */
export async function engineMeasure(
  root: string,
  files: Array<{ path: string; count: boolean }>,
  progress?: (done: number, total: number, file: string) => void,
  signal?: AbortSignal,
): Promise<Map<string, EngineMeasured> | null> {
  const answer = await ask<{ files: EngineMeasured[] }>(
    ["measure", root, ...(progress ? ["--progress"] : [])],
    files,
    progressFrom(progress),
    signal,
  );
  if (!answer || !Array.isArray(answer.files) || answer.files.length !== files.length) {
    if (answer) broken = "cbx-engine measure answered for the wrong number of files";
    return null;
  }
  const byPath = new Map<string, EngineMeasured>();
  for (const one of answer.files) byPath.set(one.path, one);
  return byPath;
}

export type EngineFound = { path: string; size: number; mtimeMs: number; mode: number };

/**
 * The files the ignore rules let into a save, found by the engine's own walk.
 *
 * Decided exactly as core/rules.ts and the walks in core/worktree.ts decide (the cross-test
 * engine/compat/rules-cross.mjs compares them under many rule sets), returned in the order
 * changedFiles meets them: breadth first, each folder in disk order. `rules` is what readRules
 * gave; `tracked` what gitTracked gave. Each file's size, mtimeMs and mode come from one stat.
 * Null when there is no engine or the walk failed, including on a rule JavaScript could not
 * compile, so the TypeScript walk runs and fails in its own words.
 */
export async function engineScan(
  root: string,
  rules: { shared: string; local: string },
  tracked: { files: Set<string>; folders: Set<string> } | null,
  /** How many files the folder held last time, when known; a small folder is walked faster without a process. */
  expectedFiles?: number,
  /**
   * Stat every file (the default). False lets the engine use the size and time the folder
   * listing already carries, which costs nothing per file on Windows; a file still open for
   * writing can show its previous size and time there, so only read-only reports ask for it.
   */
  exact = true,
): Promise<EngineFound[] | null> {
  if (!enginePath() || broken) return null;
  if (expectedFiles !== undefined && expectedFiles < ENGINE_SCAN_MIN_FILES && process.env.CBX_ENGINE_ALWAYS !== "1") return null;
  if (process.env.CBX_ENGINE_SCAN === "off") return null;
  const answer = await ask<{ files?: EngineFound[]; invalidRule?: string }>(["scan"], {
    root,
    shared: rules.shared,
    local: rules.local,
    trackedFiles: tracked ? [...tracked.files] : null,
    trackedFolders: tracked ? [...tracked.folders] : null,
    exact,
  });
  if (!answer || answer.invalidRule || !Array.isArray(answer.files)) return null;
  return answer.files;
}

/** For tests: forget what was found, so a changed CBX_ENGINE is read again. */
export function resetEngineForTests(): void {
  located = undefined;
  broken = null;
}

export type EngineQuick =
  | { answer: "clean"; root: string; project: string; line: string; head: string; message: string }
  | {
      answer: "changed";
      root: string;
      project: string;
      line: string;
      head: string;
      message: string;
      added: string[];
      modified: string[];
      deleted: string[];
    }
  | { answer: "unknown"; reason: string };

/**
 * A quiet status answered by the engine alone (engine/src/quick.rs): "clean"
 * only when a cbx-local 2 history's folder is exactly the line's newest save,
 * judged from the stamp status leaves in the index and a walk of the folder.
 * Anything else, and an engine too old to know the command, is null or
 * "unknown", and the full status answers. Never marks the engine broken: an
 * older engine still scans for that full status.
 */
export async function engineQuickStatus(from: string): Promise<EngineQuick | null> {
  if (!enginePath() || broken || process.env.CBX_ENGINE_QUICK === "off" || !usable()) return null;
  const answer = await run(["quick-status", from], "");
  if (answer.code !== 0) return null;
  try {
    const parsed = JSON.parse(answer.stdout) as EngineQuick & { protocol?: number };
    return parsed.protocol === PROTOCOL ? parsed : null;
  } catch {
    return null;
  }
}
