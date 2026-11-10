/**
 * Working on a remote draft from a machine's own folder, and handing a draft
 * to another machine (backend workspace_assignments.ts).
 *
 *   cbx workspace assign <project> <draft> [--name "Laptop"] [--days 14]
 *       make a token that reaches that one draft; shown once
 *   cbx workspace assignments <project> <draft>     the live ones
 *   cbx workspace unassign <project> <draft> <id>   end one
 *   cbx workspace checkout <project> <draft> [folder]
 *       the draft as files: its base version, with the draft's edits on top
 *   cbx workspace push [folder] [--save -m "…"] [--dry-run]
 *       send this folder's text changes into the draft, and save it if asked
 *
 * A checked-out folder is not a linked folder: `cbx submit` does not apply to
 * it, and its record lives in .coderook/workspace.json. Edits go in as the
 * draft's own changes, each checked against the copy this folder last had,
 * so somebody else's edit to the same file in the meantime is refused rather
 * than overwritten. Text only, 1 MiB a file, as the draft itself allows.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DownloadFailed, Downloader } from "../../cbx/src/core/download.js";
import { changedFiles, readRules } from "../../cbx/src/core/worktree.js";
import { callApi, callApiBytes, findProject } from "./api.js";
import { credentials } from "./config.js";
import { checkIn } from "./machine.js";
import type { Parsed } from "./registry.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { batches, encodeFile } from "./workspace_put.js";

const RECORD = path.join(".coderook", "workspace.json");
/* The draft's own limit per text file (backend remote_workspaces.ts MAX_EDIT_BYTES). */
const MAX_FILE = 1024 * 1024;
/*
  One request to the draft may be 2 MiB. Batches are measured as the JSON that
  is sent, since escaping makes content larger than its bytes on disk, and kept
  well under the cap.
*/
const MAX_REQUEST = 2 * 1024 * 1024;
const encodedSize = (change: unknown) => Buffer.byteLength(JSON.stringify(change));

type Record_ = {
  projectId: string;
  projectSlug: string;
  workspaceId: string;
  name: string;
  revision: number;
  baseVersionId: string;
  track: string;
  /** Every file this folder was given, by path, with its SHA-256. */
  files: Record<string, string>;
};

type WorkspaceInfo = {
  workspace: { id: string; name: string; revision: number; baseVersionId: string; track: string };
};

/** One draft text file in full, from the line-paged read (2,000 lines a request). */
export async function readWhole(
  draft: string,
  filePath: string,
  read: (route: string) => Promise<{ content: string; truncated: boolean }> = (route) => callApi(route),
): Promise<string> {
  const lines: string[] = [];
  for (let start = 1; ; ) {
    const page = await read(`${draft}/files?path=${encodeURIComponent(filePath)}&startLine=${start}&lines=2000`);
    const got = page.content.split("\n");
    lines.push(...got);
    if (!page.truncated) break;
    start += got.length;
  }
  return lines.join("\n");
}

type DiffPage = {
  revision: number;
  changes: Array<{
    path: string;
    removed: boolean;
    after: { sha256: string; content: string | null; reason?: string } | null;
  }>;
  nextOffset: number | null;
};

function flag(parsed: Parsed, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const key = (what: string) => `${what}-${randomBytes(9).toString("base64url")}`;

async function readRecord(folder: string): Promise<Record_> {
  try {
    return JSON.parse(await readFile(path.join(folder, RECORD), "utf8")) as Record_;
  } catch {
    throw new Error(`${folder} is not a checked-out draft. Get one with: cbx workspace checkout <project> <draft> [folder]`);
  }
}

async function writeRecord(folder: string, record: Record_): Promise<void> {
  await mkdir(path.join(folder, ".coderook"), { recursive: true });
  await writeFile(path.join(folder, RECORD), JSON.stringify(record, null, 2) + "\n");
}

async function project(reference: string | undefined) {
  if (!reference) throw new Error("Which project? Name it after the operation.");
  const found = await findProject(reference);
  if (!found) throw new Error(`No accessible project ${reference}`);
  return found;
}

/** The operations this file handles; anything else is the generic workspace command's. */
export const MACHINE_OPERATIONS = new Set(["assign", "assignments", "unassign", "checkout", "push"]);

export async function commandWorkspaceMachine(parsed: Parsed): Promise<number> {
  const [operation, first, second, third] = parsed.positional;
  if (operation === "push") return push(parsed, first ?? ".");
  const found = await project(first);
  const root = `/v1/repositories/${encodeURIComponent(found.id)}/workspaces`;
  if (!second) throw new Error("Name the draft (its ID) after the project. List them with: cbx workspace list <project>");
  const draft = `${root}/${encodeURIComponent(second)}`;

  if (operation === "assign") {
    const days = flag(parsed, "days");
    const made = await callApi<{ token: string; assignment: { id: string; expiresAt: string | null } }>(`${draft}/assignments`, {
      method: "POST",
      body: { name: flag(parsed, "name"), ...(days ? { days: Number(days) } : {}) },
    });
    console.log(`${green("Handed over.")} This token reaches draft ${second} only, until ${made.assignment.expiresAt ? new Date(made.assignment.expiresAt).toLocaleDateString() : "it is revoked"}.`);
    console.log(dim("It is shown once. Give it to the other machine privately."));
    console.log(`\n  ${bold(made.token)}\n`);
    console.log("On that machine:");
    console.log(`  ${accent("npm install -g @coderook/cli")}`);
    console.log(`  ${accent("cbx sign-in")}                         ${dim("paste the token when asked")}`);
    console.log(`  ${accent(`cbx workspace checkout ${found.slug} ${second}`)}`);
    console.log(`  ${dim("…work, then")} ${accent('cbx workspace push --save -m "What changed"')}`);
    console.log(dim(`\nEnd it early: cbx workspace unassign ${found.slug} ${second} ${made.assignment.id}`));
    return 0;
  }
  if (operation === "assignments") {
    const listed = await callApi<{ assignments: Array<{ id: string; name: string; prefix: string; expiresAt: string | null; lastUsedAt: string | null }> }>(
      `${draft}/assignments`,
    );
    if (!listed.assignments.length) console.log(dim("This draft is not handed to any machine."));
    for (const one of listed.assignments) {
      console.log(
        `${bold(one.name)}  ${dim(one.prefix + "…")}  ${dim(`until ${one.expiresAt ? new Date(one.expiresAt).toLocaleDateString() : "revoked"}`)}  ` +
          dim(one.lastUsedAt ? `last used ${new Date(one.lastUsedAt).toLocaleString()}` : "not used yet") +
          dim(`  ${one.id}`),
      );
    }
    return 0;
  }
  if (operation === "unassign") {
    if (!third) throw new Error("Name the assignment's ID after the draft. See them with: cbx workspace assignments <project> <draft>");
    await callApi(`${draft}/assignments/${encodeURIComponent(third)}`, { method: "DELETE" });
    console.log(`${green("Ended.")} That machine can no longer reach the draft.`);
    return 0;
  }
  return checkout(found, draft, second, third);
}

async function checkout(found: { id: string; slug: string }, draft: string, workspaceId: string, into: string | undefined): Promise<number> {
  const folder = path.resolve(into ?? `${found.slug}-draft`);
  if (existsSync(path.join(folder, RECORD))) {
    console.error(red(`${folder} already holds a checked-out draft. Use cbx workspace push there, or choose another folder.`));
    return 1;
  }
  const info = await callApi<WorkspaceInfo>(draft);
  const downloader = new Downloader(credentials);
  let manifest: Record<string, string>;
  try {
    const result = await downloader.run(found.id, info.workspace.baseVersionId, folder, () => undefined, null, "replace");
    manifest = { ...result.manifest };
  } catch (error) {
    if (error instanceof DownloadFailed) {
      console.error(red(error.message));
      return 1;
    }
    throw error;
  }
  // The draft's own edits on top, each checked against the hash the draft gives for it.
  let revision = info.workspace.revision;
  let edited = 0;
  for (let offset: number | null = 0; offset !== null; ) {
    const page: DiffPage = await callApi<DiffPage>(`${draft}/diff?offset=${offset}`);
    revision = page.revision;
    for (const change of page.changes) {
      const target = path.join(folder, ...change.path.split("/"));
      if (change.removed || !change.after) {
        await rm(target, { force: true });
        delete manifest[change.path];
      } else {
        /*
          A diff page carries at most 4 MiB of content; a text file past that
          budget comes with only its digest, and is read on its own, a page of
          lines at a time.
        */
        if (change.after.content === null && change.after.reason?.startsWith("page byte limit")) {
          change.after.content = await readWhole(draft, change.path);
        }
        /* Not text (an image, a font, an archive): its exact bytes, from the draft's raw read. */
        const body: Uint8Array | string =
          change.after.content ??
          (await callApiBytes(`${draft}/raw?path=${encodeURIComponent(change.path)}`));
        if (sha(body) !== change.after.sha256) {
          throw new Error(`The draft's copy of ${change.path} did not arrive exactly; nothing was overwritten past it. Try again.`);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, body);
        manifest[change.path] = change.after.sha256;
      }
      edited += 1;
    }
    offset = page.nextOffset;
  }
  await writeRecord(folder, {
    projectId: found.id,
    projectSlug: found.slug,
    workspaceId,
    name: info.workspace.name,
    revision,
    baseVersionId: info.workspace.baseVersionId,
    track: info.workspace.track,
    files: manifest,
  });
  await checkIn(found.id, { kind: "workspace", folder, workspaceId, track: info.workspace.track, baseVersionId: info.workspace.baseVersionId, changedFiles: 0 });
  console.log(`${green("Checked out")} ${bold(info.workspace.name)} into ${folder}`);
  console.log(dim(`  ${Object.keys(manifest).length} files · revision ${revision}${edited ? ` · ${edited} edited in the draft` : ""}`));
  console.log(dim("  Send changes back with ") + accent("cbx workspace push") + dim(", and save with ") + accent('cbx workspace push --save -m "…"'));
  return 0;
}

async function push(parsed: Parsed, where: string): Promise<number> {
  const folder = path.resolve(where);
  const record = await readRecord(folder);
  const draft = `/v1/repositories/${encodeURIComponent(record.projectId)}/workspaces/${encodeURIComponent(record.workspaceId)}`;
  const rules = await readRules(folder);
  const found = await changedFiles(folder, rules, new Map(Object.entries(record.files)), "synchronize");
  const changes: Array<{ path: string; content?: string; contentBase64?: string; remove?: true; expectedSha256: string | null }> = [];
  const sent = new Map<string, string>();
  const sizes = new Map<string, number>();
  const refused: string[] = [];
  for (const file of found) {
    if (file.path === RECORD.replaceAll("\\", "/") || file.path.startsWith(".coderook/")) continue;
    if (file.deleted) {
      changes.push({ path: file.path, remove: true, expectedSha256: record.files[file.path] ?? null });
      continue;
    }
    const bytes = await readFile(path.join(folder, ...file.path.split("/")));
    if (bytes.length > MAX_FILE) {
      refused.push(file.path);
      continue;
    }
    /* Text as text; images, fonts and other binary files as base64. */
    const change = { path: file.path, ...encodeFile(bytes), expectedSha256: record.files[file.path] ?? null };
    sent.set(file.path, sha(bytes));
    sizes.set(file.path, bytes.length);
    /* Under 1 MiB but so full of escapes that it cannot travel in one request. */
    if (encodedSize(change) > MAX_REQUEST - 64 * 1024) {
      refused.push(file.path);
      continue;
    }
    changes.push(change);
  }
  if (refused.length) {
    console.error(red(`${refused.length} file${refused.length === 1 ? " is" : "s are"} over 1 MiB, which a draft cannot take:`));
    for (const one of refused.slice(0, 20)) console.error(`  ${one}`);
    console.error(dim("Nothing was sent. Leave them out, or save them with a normal upload from a linked folder."));
    return 1;
  }
  if (!changes.length && !parsed.flags.has("save")) {
    console.log("Nothing changed since this folder's last push.");
    return 0;
  }
  if (parsed.flags.has("dry-run")) {
    for (const one of changes) console.log(`  ${one.remove ? red("removed") : record.files[one.path] ? "changed" : green("new")}  ${one.path}`);
    console.log(dim(`${changes.length} change${changes.length === 1 ? "" : "s"} would go to draft ${record.name}.`));
    return 0;
  }
  // In batches the draft accepts, each against the revision the last one made.
  let revision = record.revision;
  for (const batch of batches(changes, sizes)) {
    const result = await callApi<{ workspace: { revision: number } }>(`${draft}/changes`, {
      method: "POST",
      body: { expectedRevision: revision, operationKey: key("push"), changes: batch },
    });
    revision = result.workspace.revision;
    for (const one of batch) {
      if (one.remove) delete record.files[one.path];
      else record.files[one.path] = sent.get(one.path)!;
    }
    record.revision = revision;
    await writeRecord(folder, record);
  }
  if (changes.length) console.log(`${green("Sent")} ${changes.length} change${changes.length === 1 ? "" : "s"} to ${bold(record.name)} · revision ${revision}`);
  if (parsed.flags.has("save")) {
    const message = flag(parsed, "m", "message");
    if (!message) {
      console.error(red('Say what changed: cbx workspace push --save -m "…"'));
      return 1;
    }
    const saved = await callApi<{
      version?: { sequence?: number };
      mergeTrack?: { reference?: string } | null;
      review?: { line: string; into: string; pull: { reference: string } | null };
    }>(`${draft}/save`, {
      method: "POST",
      body: { expectedRevision: revision, operationKey: key("save"), message },
    });
    if (saved.mergeTrack) {
      console.log(`${accent("Saved onto a merge track")} ${saved.mergeTrack.reference ?? ""}: somebody else changed the same lines, so it waits to be settled.`);
    } else if (saved.review) {
      // A machine the draft was handed to saves to the draft's own line, for the owner to merge.
      console.log(`${green("Saved")} as v${saved.version?.sequence ?? "?"} on ${accent(saved.review.line)}.`);
      console.log(
        saved.review.pull
          ? dim(`  Pull request ${saved.review.pull.reference} carries it to ${saved.review.into}; it lands when the owner or a reviewer merges it.`)
          : dim(`  The owner merges it into ${saved.review.into} from that line.`),
      );
    } else {
      console.log(`${green("Saved")} as v${saved.version?.sequence ?? "?"} on ${record.track}.`);
    }
  }
  await checkIn(record.projectId, { kind: "workspace", folder, workspaceId: record.workspaceId, track: record.track, baseVersionId: record.baseVersionId, changedFiles: 0 });
  return 0;
}

type Machine = {
  kind: "folder" | "workspace";
  name: string;
  folderName: string | null;
  track: string | null;
  person: { displayName: string };
  mine: boolean;
  baseSequence: number | null;
  lineSequence: number | null;
  changedFiles: number | null;
  workspace: { name: string } | null;
  clientVersion: string | null;
  lastSeenAt: string;
};
type Runner = { name: string; platform: string | null; lastSeenAt: string; runsClaimed: number };

function ago(when: string): string {
  const minutes = Math.round((Date.now() - Date.parse(when)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** cbx machines [project]: the PCs working on a project, and its runners. */
export async function commandMachines(parsed: Parsed, linkedProject: string | null): Promise<number> {
  const reference = parsed.positional[0] ?? linkedProject;
  if (!reference) throw new Error("Which project? Try: cbx machines <project>, or run it in a linked folder.");
  const found = await project(reference);
  const root = `/v1/repositories/${encodeURIComponent(found.id)}`;
  const [machines, runners] = await Promise.all([
    callApi<{ machines: Machine[] }>(`${root}/machines`),
    callApi<{ runners: Runner[] }>(`${root}/runners`).catch(() => ({ runners: [] as Runner[] })),
  ]);
  console.log(bold(found.slug));
  console.log(dim("Linked folders and handed-over drafts"));
  if (!machines.machines.length) console.log(dim("  None in the last 30 days."));
  for (const one of machines.machines) {
    const behind =
      one.baseSequence !== null && one.lineSequence !== null
        ? one.lineSequence > one.baseSequence
          ? red(`${one.lineSequence - one.baseSequence} behind`)
          : green("up to date")
        : dim("version unknown");
    const what = one.kind === "workspace" ? `draft ${one.workspace?.name ?? "(private)"}` : `folder ${one.folderName ?? "?"}`;
    console.log(
      `  ${bold(one.name)}${one.mine ? dim(" (you)") : ""}  ${dim(one.person.displayName)}  ${what}` +
        `  ${one.baseSequence !== null ? `v${one.baseSequence}` : ""} ${behind}` +
        `  ${one.changedFiles === null ? "" : one.changedFiles ? `${one.changedFiles} unsaved` : dim("nothing unsaved")}` +
        `  ${dim(ago(one.lastSeenAt))}`,
    );
  }
  console.log(dim("Runners"));
  if (!runners.runners.length) console.log(dim("  None connected."));
  for (const one of runners.runners) {
    const online = Date.now() - Date.parse(one.lastSeenAt) < 120000;
    console.log(`  ${bold(one.name)}  ${dim(one.platform ?? "")}  ${online ? green("online") : dim("offline")}  ${dim(`${one.runsClaimed} runs · ${ago(one.lastSeenAt)}`)}`);
  }
  return 0;
}
