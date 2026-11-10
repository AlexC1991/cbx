/**
 * cbx workspace put <project> <workspace> <path…>
 *
 * Copies files from this computer into a draft: the step every teammate and
 * assistant otherwise scripts by hand (read the file, look up the hash the
 * draft holds, build the JSON, keep under the request limits).
 *
 * - Text goes as content; anything else (images, fonts, archives, anything
 *   with a NUL byte or invalid UTF-8) goes as contentBase64.
 * - A path that no longer exists here is removed from the draft.
 * - Each change carries the hash the draft holds for that path, so a file a
 *   teammate changed meanwhile is refused instead of overwritten.
 * - Large sets are split into several edits (32 files or 1 MiB each), and
 *   each edit's key is derived from what it sends, so running the same
 *   command again after a dropped connection does not apply anything twice.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { callApi } from "./api.js";
import type { Parsed } from "./registry.js";

export type PutChange =
  | { path: string; content: string; expectedSha256: string | null }
  | { path: string; contentBase64: string; expectedSha256: string | null }
  | { path: string; remove: true; expectedSha256: string };

const MAX_FILES = 32;
const MAX_BYTES = 1024 * 1024;
/* A request may be 2 MiB; escaping and base64 make the JSON larger than the bytes, so keep well under. */
const MAX_JSON = 1536 * 1024;

/** UTF-8 text with no NUL byte travels as text; every other file as base64. */
export function encodeFile(bytes: Uint8Array): { content: string } | { contentBase64: string } {
  if (!bytes.includes(0)) {
    try {
      return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      /* not UTF-8: fall through to base64 */
    }
  }
  return { contentBase64: Buffer.from(bytes).toString("base64") };
}

/** A project-relative path with forward slashes, refusing anything outside the root. */
export function projectPath(root: string, given: string): string {
  const full = isAbsolute(given) ? given : resolve(root, given);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`${given} is outside ${root}; run from the project folder or pass --root`);
  return rel.split(sep).join("/");
}

/**
 * Groups changes into edits the service accepts: at most 32 files, 1 MiB of
 * file content and 1.5 MiB of JSON each. `sizes` gives each path's bytes on disk.
 */
export function batches<T extends { path: string }>(changes: readonly T[], sizes: ReadonlyMap<string, number>): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  let json = 0;
  for (const change of changes) {
    const size = sizes.get(change.path) ?? 0;
    const encoded = Buffer.byteLength(JSON.stringify(change));
    if (current.length && (current.length >= MAX_FILES || bytes + size > MAX_BYTES || json + encoded > MAX_JSON)) {
      out.push(current);
      current = [];
      bytes = 0;
      json = 0;
    }
    current.push(change);
    bytes += size;
    json += encoded;
  }
  if (current.length) out.push(current);
  return out;
}

/** A key that is the same whenever the same edit is sent to the same revision. */
export function editKey(revision: number, changes: readonly PutChange[]): string {
  const hash = createHash("sha256").update(JSON.stringify([revision, changes])).digest("hex");
  return `put-${revision}-${hash.slice(0, 40)}`;
}

type DraftShown = { workspace: { revision: number } };
type FilePage = { files: { path: string; sha256: string }[]; nextOffset: number | null };

export async function commandWorkspacePut(parsed: Parsed, root: string, workspace: string): Promise<number> {
  const paths = parsed.positional.slice(3);
  if (!paths.length) throw new Error("Name the files to put: cbx workspace put <project> <workspace> <path…>");
  const folder = resolve(String(parsed.flags.get("root") ?? process.cwd()));
  const draft = `${root}/workspaces/${encodeURIComponent(workspace)}`;
  const wanted = [...new Set(paths.map((p) => projectPath(folder, p)))];

  /* The hashes the draft holds now; the listing pages 500 at a time, so stop once every wanted path is found. */
  const held = new Map<string, string>();
  for (let offset: number | null = 0; offset !== null && held.size < wanted.length; ) {
    const page: FilePage = await callApi<FilePage>(`${draft}/files?offset=${offset}`);
    for (const f of page.files) if (wanted.includes(f.path)) held.set(f.path, f.sha256);
    offset = page.nextOffset;
  }

  const changes: PutChange[] = [];
  const unchanged: string[] = [];
  const sizes = new Map<string, number>();
  for (const path of wanted) {
    const local = join(folder, ...path.split("/"));
    const exists = await stat(local).then((s) => s.isFile(), () => false);
    if (!exists) {
      const sha = held.get(path);
      if (!sha) throw new Error(`${path} is neither here nor in the draft`);
      changes.push({ path, remove: true, expectedSha256: sha });
      continue;
    }
    const bytes = await readFile(local);
    if (bytes.length > MAX_BYTES)
      throw new Error(`${path} is ${bytes.length} bytes; a draft takes files up to 1 MiB. Save larger files with cbx submit.`);
    /* Already what the draft holds: nothing to send, so running put twice changes nothing. */
    if (createHash("sha256").update(bytes).digest("hex") === held.get(path)) {
      unchanged.push(path);
      continue;
    }
    sizes.set(path, bytes.length);
    changes.push({ path, ...encodeFile(bytes), expectedSha256: held.get(path) ?? null });
  }

  if (!changes.length) {
    console.log(JSON.stringify({ workspace, written: [], removed: [], binary: [], unchanged }, null, 2));
    return 0;
  }
  let revision = parsed.flags.has("revision")
    ? Number(parsed.flags.get("revision"))
    : (await callApi<DraftShown>(draft)).workspace.revision;
  const written: string[] = [];
  const removed: string[] = [];
  const binary: string[] = [];
  for (const batch of batches(changes, sizes)) {
    const out = await callApi<{ workspace: { revision: number } }>(`${draft}/changes`, {
      method: "POST",
      body: { expectedRevision: revision, operationKey: editKey(revision, batch), changes: batch },
    });
    revision = out.workspace.revision;
    for (const c of batch) {
      if ("remove" in c) removed.push(c.path);
      else written.push(c.path);
      if ("contentBase64" in c) binary.push(c.path);
    }
  }
  console.log(JSON.stringify({ workspace, revision, written, removed, binary, unchanged }, null, 2));
  return 0;
}
