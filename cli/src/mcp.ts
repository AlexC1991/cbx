/**
 * CodeRook as a tool an assistant can use.
 *
 * Claude Code and Codex both take integrations the same way: a small process
 * speaking JSON-RPC over its own stdin and stdout, launched by the assistant
 * and shut down with it. One server therefore covers both, and shipping it
 * inside the CLI means the install is the install somebody already did — no
 * second package, no second sign-in, no second copy of the upload engine.
 *
 * Written against the wire rather than against a library. The protocol here
 * is a handshake and two methods; the CLI has no runtime dependencies at all,
 * which is a large part of why installing it globally is safe, and adding a
 * dependency tree to gain three hundred lines is a poor trade.
 *
 * What it will not do matters as much as what it will. Everything here reads.
 * Nothing writes to an account, nothing deletes, and nothing signs anything
 * in or out — an assistant that has gone wrong can waste your time but cannot
 * cost you work. Saving a version stays a thing a person types.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Downloader } from "../../cbx/src/core/download.js";
import { changedFiles, readRules } from "../../cbx/src/core/worktree.js";

import { aiAccess, findProject, projects, versions } from "./api.js";
import { credentials, readLink } from "./config.js";

/** What the protocol calls itself. Both clients accept this revision. */
const PROTOCOL_VERSION = "2024-11-05";

/*
  What this build calls itself, handed in rather than written down here.

  The first version carried a literal, which the CLI already learned not to
  do: the comment beside its own VERSION says a hardcoded copy had drifted
  from what was published. Mine drifted within one release — the server
  announced 0.13.0 to Claude Code while the package was 0.14.0.
*/
let serverVersion = "0.0.0";

/** Beyond this a file is described rather than pasted into a conversation. */
const READ_LIMIT = 256 * 1024;

type Json = Record<string, unknown>;

type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  run: (input: Json) => Promise<string>;
};

function text(value: string) {
  return { content: [{ type: "text", text: value }] };
}

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

/**
 * The project a call is about, named or taken from the folder.
 *
 * Assistants are usually already sitting in a project directory, so a tool
 * that insists on being told which project every time is a tool that gets
 * called wrongly. Naming one still wins when it is given.
 */
async function resolve(named: unknown): Promise<{ id: string; slug: string }> {
  const wanted =
    (typeof named === "string" && named.trim()) ||
    (await readLink(process.cwd()))?.slug;
  if (!wanted) {
    throw new Error(
      "No project named, and this folder is not linked to one. Pass `project`.",
    );
  }
  const found = await findProject(wanted);
  if (!found) throw new Error(`No project matching "${wanted}" on your account.`);
  return { id: found.id, slug: found.slug };
}

/**
 * Whether this project's owner allows machines to read it.
 *
 * The four switches on a project are the owner's answer about automated
 * access, and an assistant reading on somebody's behalf is exactly what they
 * describe. Checked here rather than left to the service, so the refusal says
 * why in words the assistant can pass on rather than arriving as a status
 * code it will most likely retry.
 */
async function assertMayRead(repositoryId: string, slug: string): Promise<void> {
  const access = await aiAccess(repositoryId);
  if (!access.aiRead) {
    throw new Error(
      `The owner of "${slug}" has asked that machines not read it. ` +
        "A person can still open it in the desktop application or the browser.",
    );
  }
}

async function withVersion(
  projectId: string,
  wanted: unknown,
): Promise<{ id: string; sequence: number }> {
  const saved = await versions(projectId);
  if (!saved.length) throw new Error("This project has no saved versions yet.");
  if (wanted === undefined || wanted === null || wanted === "latest") {
    return { id: saved[0]!.id, sequence: saved[0]!.sequence };
  }
  const sequence = Number(wanted);
  const found = saved.find((one) => one.sequence === sequence);
  if (!found) throw new Error(`No version ${wanted} in this project.`);
  return { id: found.id, sequence: found.sequence };
}

const TOOLS: Tool[] = [
  {
    name: "coderook_projects",
    description:
      "Every project on the signed-in CodeRook account, with how much each " +
      "holds and when it last changed.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const all = await projects();
      if (!all.length) return "No projects on this account yet.";
      return all
        .map(
          (one) =>
            `${one.slug}  ${one.visibility}  ${one.versionCount} version${
              one.versionCount === 1 ? "" : "s"
            }  ${bytes(one.storedBytes ?? 0)}`,
        )
        .join("\n");
    },
  },
  {
    name: "coderook_versions",
    description:
      "What has been saved to a project, newest first. Each version is a " +
      "complete snapshot, not a difference from the one before it.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Slug. Defaults to this folder's project." },
      },
    },
    run: async (input) => {
      const project = await resolve(input.project);
      await assertMayRead(project.id, project.slug);
      const saved = await versions(project.id);
      if (!saved.length) return "No versions saved yet.";
      return saved
        .map(
          (one) =>
            `v${one.sequence}  ${one.createdAt.slice(0, 10)}  ${one.fileCount} files  ` +
            `${bytes(one.storedSize)}  ${one.message || "(no message)"}`,
        )
        .join("\n");
    },
  },
  {
    name: "coderook_files",
    description:
      "The files a version contains, with their sizes. Use before reading " +
      "one, so a path is known to exist rather than guessed at.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        version: {
          type: ["number", "string"],
          description: 'Version number, or "latest". Defaults to latest.',
        },
      },
    },
    run: async (input) => {
      const project = await resolve(input.project);
      await assertMayRead(project.id, project.slug);
      const version = await withVersion(project.id, input.version);
      const files = await new Downloader(credentials).files(project.id, version.id);
      if (!files.length) return `v${version.sequence} holds no files.`;
      const shown = files.slice(0, 2000);
      const lines = shown.map((file) => `${file.path}  ${bytes(file.sourceSize)}`);
      if (files.length > shown.length) {
        lines.push(`… and ${files.length - shown.length} more`);
      }
      return `v${version.sequence} · ${files.length} files\n${lines.join("\n")}`;
    },
  },
  {
    name: "coderook_read_file",
    description:
      "The contents of one file at one version, as stored. Verified against " +
      "the digest the version recorded.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path within the project." },
        project: { type: "string" },
        version: { type: ["number", "string"] },
      },
      required: ["path"],
    },
    run: async (input) => {
      const wanted = String(input.path ?? "").trim();
      if (!wanted) throw new Error("Which file? Pass `path`.");
      const project = await resolve(input.project);
      await assertMayRead(project.id, project.slug);
      const version = await withVersion(project.id, input.version);

      const downloader = new Downloader(credentials);
      const files = await downloader.files(project.id, version.id);
      const file = files.find((one) => one.path === wanted);
      if (!file) throw new Error(`No file "${wanted}" in v${version.sequence}.`);
      if (file.sourceSize > READ_LIMIT) {
        return (
          `${wanted} is ${bytes(file.sourceSize)}, larger than this tool will ` +
          `paste into a conversation. Fetch the project with \`cbx get\` ` +
          `and read it from disk.`
        );
      }

      /*
        Through the same download path a person uses, temporary file and all,
        rather than a second way of fetching bytes. That path verifies each
        piece against the digest the version recorded — the check that caught
        a 7.34 GB file arriving as 5.09 GB under a clean 200.
      */
      const scratch = await mkdtemp(path.join(os.tmpdir(), "coderook-mcp-"));
      try {
        const target = path.join(scratch, path.basename(wanted) || "file");
        await downloader.fileTo(project.id, version.id, file, target);
        const held = await readFile(target);
        if (held.includes(0)) {
          return `${wanted} is binary (${bytes(file.sourceSize)}); not shown.`;
        }
        return held.toString("utf8");
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  },
  {
    name: "coderook_status",
    description:
      "What has changed in a local folder since its last saved version — " +
      "added, edited and removed files. Reads the folder; changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Defaults to the working directory." },
      },
    },
    run: async (input) => {
      const folder = path.resolve(
        typeof input.folder === "string" && input.folder.trim()
          ? input.folder
          : process.cwd(),
      );
      const link = await readLink(folder);
      const rules = await readRules(folder);
      /*
        Measured against what the folder last held, as `cbx status` measures.
        Passing nothing here called every file in the folder new.
      */
      const baseline = link?.manifest
        ? new Map(Object.entries(link.local ?? link.manifest))
        : null;
      const changed = await changedFiles(folder, rules, baseline);
      const saving = howToSave(folder, link?.slug ?? null);
      if (!changed.length) return `Nothing here has changed since the last version.\n${saving}`;
      /*
        Said in the words the scan actually produces: a file the folder no
        longer has is a deletion, one with nothing removed is new, and the
        rest are edits with their line counts, because "changed" on its own
        tells an assistant nothing about how much.
      */
      const lines = changed.slice(0, 500).map((file) => {
        if (file.deleted) return `deleted  ${file.path}`;
        if (!file.removed) return `added    ${file.path}  +${file.added}`;
        return `edited   ${file.path}  +${file.added} -${file.removed}`;
      });
      if (changed.length > lines.length) {
        lines.push(`… and ${changed.length - lines.length} more`);
      }
      const where = link ? `${link.slug} (v${link.sequence})` : "not linked to a project";
      return `${folder} — ${where}\n${changed.length} changed\n${lines.join("\n")}\n${saving}`;
    },
  },
];

/**
 * Which way this folder is saved, said to the assistant reading the status.
 *
 * Saving stays something a person agrees to, so this names the command and
 * runs nothing. A git repository is pointed at git: each commit then keeps its
 * own message, where `cbx submit` would make one snapshot of all of them.
 */
function howToSave(folder: string, slug: string | null): string {
  let config: string | null = null;
  try {
    config = readFileSync(path.join(folder, ".git", "config"), "utf8");
  } catch {
    /* Not a git repository. */
  }
  if (config !== null) {
    const remote = config.match(/\[remote "([^"]+)"\][^[]*?url\s*=\s*coderook:/);
    if (remote) return `To save: commit, then git push ${remote[1]} <branch> (ask first).`;
    return (
      `This is a git repository with no CodeRook remote. To save each commit: ` +
      `git remote add coderook coderook://${slug ?? "<project>"}, then git push coderook <branch> ` +
      `(git push -o adopt the first time if the project was saved with cbx submit). Ask first.`
    );
  }
  if (slug) return `To save: cbx submit -m "…" (ask first).`;
  return `Not linked. To save, ask which project it is: cbx submit --into <project> or cbx submit --new.`;
}

/* ------------------------------------------------------------------ wire */

function reply(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: unknown, code: number, message: string) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

async function handle(request: Json): Promise<void> {
  const { id, method, params } = request as {
    id?: unknown;
    method?: string;
    params?: Json;
  };

  /*
    Notifications carry no id and expect no answer. Replying to one is a
    protocol error, and the client that receives it is entitled to hang up.
  */
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "coderook", version: serverVersion },
    });
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (method === "tools/list") {
    reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
    return;
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const tool = TOOLS.find((one) => one.name === name);
    if (!tool) {
      if (!isNotification) fail(id, -32602, `No tool called "${name}".`);
      return;
    }
    try {
      const answer = await tool.run((params?.arguments as Json) ?? {});
      reply(id, text(answer));
    } catch (error) {
      /*
        Returned as a result rather than a protocol error. A refusal — the
        owner does not allow machines, the file is not there — is an answer
        the assistant should read and act on, where a JSON-RPC error is
        something it will most likely retry or surface as a crash.
      */
      reply(id, {
        ...text(error instanceof Error ? error.message : String(error)),
        isError: true,
      });
    }
    return;
  }

  if (!isNotification) fail(id, -32601, `Unsupported method "${method}".`);
}

/**
 * Read newline-delimited JSON from stdin until it closes.
 *
 * Buffered by line rather than by chunk, because a chunk boundary falls
 * wherever the pipe decides and a half-read message parses as nothing.
 */
export async function commandMcp(version: string): Promise<number> {
  serverVersion = version;
  process.stdin.setEncoding("utf8");
  let buffer = "";

  await new Promise<void>((done) => {
    process.stdin.on("data", (piece: string) => {
      buffer += piece;
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf("\n");
        if (!line) continue;
        try {
          void handle(JSON.parse(line) as Json);
        } catch {
          /* Not JSON. Nothing to answer, and nobody to answer to. */
        }
      }
    });
    process.stdin.on("end", () => done());
    process.stdin.on("close", () => done());
  });

  return 0;
}
