/**
 * Between a folder and a tree: reading one into the other, and back.
 *
 * Which files count is decided the way CodeRook decides it — the folder's
 * ignore rules, read by `readRules` and walked by `surveyFiles` — so a local
 * save and a save sent to CodeRook hold the same files.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { readRules, surveyFiles } from "../core/worktree.js";
import { cutPoints, profileForFileSize } from "../shared/chunking.js";
import { inside } from "../shared/safe_path.js";
import type { IndexEntry, Repository, Tree, TreeEntry } from "./repository.js";

const READ_SIZE = 8 * 1024 * 1024;

/*
  How close to now a modification time has to be before it is not trusted.

  A file written in the same instant the index records it can be written
  again without its time moving, and the index would then vouch for bytes
  that are no longer there. Git calls these racily clean. Anything this
  recent is simply read again next time.
*/
const RACY_WINDOW_MS = 2_000;

export type FolderFile = {
  path: string;
  size: number;
  mtimeMs: number;
  mode: number;
};

export type Progress = (done: number, total: number, file: string) => void;

/*
  How many files are worked on at once.

  One at a time, a save of twenty thousand small files took seventy-seven
  seconds, almost all of it waiting on the disk between one small request and
  the next. Files over eight megabytes get far fewer lanes, because each one
  holds up to forty megabytes while it is being cut.
*/
const SMALL_LANES = 16;
const LARGE_LANES = 2;

/** Run `work` over `items`, `count` at a time. */
export async function inLanes<T>(items: readonly T[], count: number, work: (item: T) => Promise<void>): Promise<void> {
  let at = 0;
  const lane = async (): Promise<void> => {
    while (at < items.length) {
      const item = items[at]!;
      at += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, () => lane()));
}

/** The files the rules would save, with what `stat` says about each. */
export async function listFolder(root: string): Promise<FolderFile[]> {
  const rules = await readRules(root);
  const found = await surveyFiles(root, rules);
  const files: FolderFile[] = [];
  await inLanes(found, SMALL_LANES, async (one) => {
    try {
      const info = await stat(path.join(root, one.path));
      files.push({ path: one.path, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode });
    } catch {
      /* Gone since the walk; it is not in the folder any more. */
    }
  });
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function executableFrom(mode: number, previous: TreeEntry | undefined): boolean {
  /* Windows has no execute bit to read, so whatever was saved last stands. */
  if (process.platform === "win32") return previous?.executable ?? false;
  return (mode & 0o100) !== 0;
}

/** A file's digest, streamed so a large one is never held whole. */
async function digestFile(full: string, size: number): Promise<string> {
  /*
    Read whole when small. A stream asks for its full window up front, and
    an eight megabyte window per file turned hashing twenty thousand small
    files into forty-five seconds of allocating memory nobody used.
  */
  if (size <= READ_SIZE) return createHash("sha256").update(await readFile(full)).digest("hex");
  const hash = createHash("sha256");
  for await (const block of createReadStream(full, { highWaterMark: READ_SIZE })) {
    hash.update(block as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Read a file into the store: its digest, and the objects its bytes become.
 *
 * Under eight megabytes a file is one object. Above, it is cut where its
 * content says to, with the same profile a CodeRook upload uses for a file
 * that size, so an edit in the middle of a large asset stores the pieces
 * around the edit and reuses the rest.
 */
export async function storeFile(
  repository: Repository,
  full: string,
  size: number,
): Promise<{ sha256: string; chunks: string[] }> {
  const profile = profileForFileSize(size);
  if (!profile) {
    const bytes = await readFile(full);
    const digest = await repository.objects.put(bytes);
    return { sha256: digest, chunks: bytes.length ? [digest] : [] };
  }
  const whole = createHash("sha256");
  const chunks: string[] = [];
  let pending = Buffer.alloc(0);
  for await (const piece of createReadStream(full, { highWaterMark: READ_SIZE })) {
    const block = piece as Buffer;
    whole.update(block);
    pending = pending.length ? Buffer.concat([pending, block]) : Buffer.from(block);
    let from = 0;
    for (const cut of cutPoints(pending, profile)) {
      chunks.push(await repository.objects.put(Buffer.from(pending.subarray(from, cut))));
      from = cut;
    }
    pending = pending.subarray(from);
  }
  if (pending.length) chunks.push(await repository.objects.put(Buffer.from(pending)));
  return { sha256: whole.digest("hex"), chunks };
}

export type Reading = {
  /** Every file, keyed by path. `chunks` is empty unless the files were stored. */
  files: Map<string, TreeEntry>;
  index: Map<string, IndexEntry>;
};

/**
 * What the folder holds now.
 *
 * With `store` the bytes of every changed file go into the object store and
 * each entry carries its objects, ready to become a tree. Without, files are
 * only hashed, which is all a status or a diff needs, and nothing is written.
 * Either way a file whose size and time match the index is not read at all.
 */
export async function readFolder(
  repository: Repository,
  options: { store: boolean; previous?: Tree | null; progress?: Progress },
): Promise<Reading> {
  const index = await repository.readIndex();
  const previous = new Map(options.previous?.files.map((file) => [file.path, file]) ?? []);
  const listed = await listFolder(repository.root);
  const files = new Map<string, TreeEntry>();
  const next = new Map<string, IndexEntry>();
  const racyBefore = Date.now() - RACY_WINDOW_MS;

  let done = 0;
  const one = async (file: FolderFile): Promise<void> => {
    const full = path.join(repository.root, file.path);
    const known = index.get(file.path);
    let sha256: string;
    let chunks: string[] = [];
    const unchanged =
      known &&
      known.size === file.size &&
      known.mtimeMs === file.mtimeMs &&
      (!options.store || known.chunks.length > 0 || file.size === 0);
    if (unchanged) {
      sha256 = known.sha256;
      chunks = known.chunks;
    } else if (options.store) {
      ({ sha256, chunks } = await storeFile(repository, full, file.size));
    } else {
      sha256 = await digestFile(full, file.size);
    }
    files.set(file.path, {
      path: file.path,
      size: file.size,
      sha256,
      executable: executableFrom(file.mode, previous.get(file.path)),
      chunks,
    });
    if (file.mtimeMs < racyBefore) {
      next.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, sha256, chunks });
    }
    done += 1;
    options.progress?.(done, listed.length, file.path);
  };
  const large = (file: FolderFile) => profileForFileSize(file.size) !== null;
  await Promise.all([
    inLanes(listed.filter((file) => !large(file)), SMALL_LANES, one),
    inLanes(listed.filter(large), LARGE_LANES, one),
  ]);
  /* Nothing may name an object that is not on disk yet. */
  if (options.store) await repository.objects.flush();
  options.progress?.(listed.length, listed.length, "");
  return { files, index: next };
}

/** A tree entry's bytes, put back together from the store and checked. */
export async function contentsOf(repository: Repository, entry: TreeEntry): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (const chunk of entry.chunks) pieces.push(await repository.objects.get(chunk));
  const contents = Buffer.concat(pieces);
  if (
    contents.length !== entry.size ||
    createHash("sha256").update(contents).digest("hex") !== entry.sha256
  ) {
    throw new Error(`${entry.path} in the history does not match its record.`);
  }
  return contents;
}

/**
 * Write one tree entry into the folder.
 *
 * Assembled beside the file and renamed over it, so a failure part-way
 * leaves the old file rather than half of the new one. Pieces are streamed to
 * disk one at a time, and the digest is checked before the rename.
 */
async function writeEntry(
  repository: Repository,
  root: string,
  entry: TreeEntry,
  folders: Map<string, Promise<unknown>>,
): Promise<void> {
  /* Refuses `..`, absolute paths, `.git` and `.cbx`; see safe_path.ts. */
  const full = inside(root, entry.path);
  /* Each folder made once, however many files land in it. */
  const folder = path.dirname(full);
  let making = folders.get(folder);
  if (!making) {
    making = mkdir(folder, { recursive: true });
    folders.set(folder, making);
  }
  await making;
  const partial = `${full}.${randomBytes(6).toString("hex")}.cbx-partial`;
  const finish = async (): Promise<void> => {
    if (process.platform !== "win32") {
      await chmod(partial, entry.executable ? 0o755 : 0o644);
    }
    /* Replaces what is there in one step; removing it first left a gap. */
    await rename(partial, full);
  };
  if (entry.chunks.length <= 1) {
    const raw = entry.chunks.length ? await repository.objects.get(entry.chunks[0]!) : Buffer.alloc(0);
    if (raw.length !== entry.size || createHash("sha256").update(raw).digest("hex") !== entry.sha256) {
      throw new Error(`${entry.path} in the history does not match its record.`);
    }
    /*
      Nothing there yet, so nothing to leave half-replaced: written straight
      to its name, which is a third of the cost of writing beside it and
      renaming. An interrupted write leaves a file that no longer matches,
      which the next status reports and a restore puts right.
    */
    try {
      await writeFile(full, raw, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      await writeFile(partial, raw);
      await finish();
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return;
  }
  const handle = await open(partial, "w");
  const hash = createHash("sha256");
  let written = 0;
  try {
    for (const chunk of entry.chunks) {
      const raw = await repository.objects.get(chunk);
      hash.update(raw);
      await handle.write(raw, 0, raw.length, written);
      written += raw.length;
    }
    await handle.close();
    if (written !== entry.size || hash.digest("hex") !== entry.sha256) {
      throw new Error(`${entry.path} in the history does not match its record.`);
    }
    await finish();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
}

/** Remove folders this left empty, stopping at the root or the first one in use. */
async function pruneEmpty(root: string, from: string): Promise<void> {
  let at = path.dirname(from);
  const base = path.resolve(root);
  while (at.startsWith(base + path.sep)) {
    try {
      if ((await readdir(at)).length) return;
      await rmdir(at);
    } catch {
      return;
    }
    at = path.dirname(at);
  }
}

export type Checkout = { written: string[]; removed: string[] };

/**
 * Make the folder's files match `to`, where they are currently `from`.
 *
 * Only what differs is touched: a file identical in both is left exactly as
 * it is, and a file in neither — anything the history does not hold — is
 * never looked at. `only`, when given, limits the change to those paths.
 */
export async function checkout(
  repository: Repository,
  from: Map<string, TreeEntry>,
  to: Tree,
  only?: (file: string) => boolean,
): Promise<Checkout> {
  const target = new Map(to.files.map((file) => [file.path, file]));
  const written: string[] = [];
  const removed: string[] = [];

  const changed = to.files.filter((entry) => {
    if (only && !only(entry.path)) return false;
    return !sameFile(from.get(entry.path), entry);
  });
  const folders = new Map<string, Promise<unknown>>();
  await inLanes(changed, SMALL_LANES, async (entry) => {
    await writeEntry(repository, repository.root, entry, folders);
    written.push(entry.path);
  });
  written.sort();
  for (const file of from.keys()) {
    if (target.has(file) || (only && !only(file))) continue;
    const full = inside(repository.root, file);
    await rm(full, { force: true });
    await pruneEmpty(repository.root, full);
    removed.push(file);
  }
  return { written, removed };
}

/** Whether two entries hold the same file, bytes and execute bit alike. */
export function sameFile(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
  return (
    !!left && !!right && left.sha256 === right.sha256 && left.executable === right.executable
  );
}

/**
 * Write entries into a folder other than the project: the scratch tree a
 * push sends from. Nothing there is checked against unsaved work, because
 * nothing there is anybody's work.
 */
export async function writeEntriesInto(
  repository: Repository,
  root: string,
  entries: readonly TreeEntry[],
): Promise<void> {
  const folders = new Map<string, Promise<unknown>>();
  await inLanes(entries, SMALL_LANES, (entry) => writeEntry(repository, root, entry, folders));
}
