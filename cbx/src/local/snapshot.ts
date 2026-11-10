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

import { gitTracked, readRules, surveyFiles } from "../core/worktree.js";
import { cutPoints, profileForFileSize } from "../shared/chunking.js";
import {
  engineMeasure,
  engineScan,
  engineStore,
  worthTheEngine,
  type EngineMeasured,
  type EngineStored,
} from "../shared/native_engine.js";
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
export async function listFolder(root: string, expectedFiles?: number, exact = true): Promise<FolderFile[]> {
  const rules = await readRules(root);
  /* The native engine walks and stats in one pass when there is one; otherwise the walk below and a stat each. */
  const native = await engineScan(root, rules, await gitTracked(root), expectedFiles, exact);
  if (native) {
    return native
      .map((one) => ({ path: one.path, size: one.size, mtimeMs: one.mtimeMs, mode: one.mode }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }
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
  /*
    For a v2 history: where the file sits, and what it was last time (or,
    for a new file, a file like it), so its objects can be kept as deltas.
  */
  hints?: { path: string; previous?: TreeEntry; similar?: TreeEntry },
): Promise<{ sha256: string; chunks: string[] }> {
  const profile = profileForFileSize(size);
  if (!profile) {
    const bytes = await readFile(full);
    const was = hints?.previous?.chunks.length === 1 ? hints.previous : hints?.similar;
    const base = was?.chunks.length === 1 ? was.chunks[0] : undefined;
    const digest = await repository.objects.put(bytes, {
      ...(base ? { base } : {}),
      ...(hints ? { path: hints.path } : {}),
    });
    return { sha256: digest, chunks: bytes.length ? [digest] : [] };
  }
  /*
    The old pieces by where they started, so each new piece is kept as a
    delta against the old piece at the same place: an edit inside a big file
    changes the pieces around it, and those resemble what they replaced.
  */
  const before = hints?.previous?.chunks ?? [];
  const starts: number[] = [];
  if (before.length && repository.objects.v2) {
    let at = 0;
    for (const digest of before) {
      starts.push(at);
      const length = await repository.objects.rawSize(digest);
      if (length === null) {
        starts.length = 0;
        break;
      }
      at += length;
    }
  }
  const baseAt = (offset: number): string | undefined => {
    if (!starts.length) return undefined;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return before[low];
  };
  let written = 0;
  const keep = async (piece: Buffer): Promise<string> => {
    const base = baseAt(written);
    written += piece.length;
    return repository.objects.put(piece, {
      ...(base ? { base } : {}),
      ...(hints ? { path: hints.path } : {}),
    });
  };
  const whole = createHash("sha256");
  const chunks: string[] = [];
  let pending = Buffer.alloc(0);
  for await (const piece of createReadStream(full, { highWaterMark: READ_SIZE })) {
    const block = piece as Buffer;
    whole.update(block);
    pending = pending.length ? Buffer.concat([pending, block]) : Buffer.from(block);
    let from = 0;
    for (const cut of cutPoints(pending, profile)) {
      chunks.push(await keep(Buffer.from(pending.subarray(from, cut))));
      from = cut;
    }
    pending = pending.subarray(from);
  }
  if (pending.length) chunks.push(await keep(Buffer.from(pending)));
  return { sha256: whole.digest("hex"), chunks };
}

export type Reading = {
  /** Every file, keyed by path. `chunks` is empty unless the files were stored. */
  files: Map<string, TreeEntry>;
  index: Map<string, IndexEntry>;
  /** Whether `index` differs from the one read, so a status that found nothing new need not write it. */
  indexChanged: boolean;
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
  options: {
    store: boolean;
    previous?: Tree | null;
    progress?: Progress;
    /** False for a read-only report: the listing's sizes and times may stand in for a stat (see engineScan). */
    exact?: boolean;
  },
): Promise<Reading> {
  const index = await repository.readIndex();
  const previous = new Map(options.previous?.files.map((file) => [file.path, file]) ?? []);
  const listed = await listFolder(repository.root, index.size || undefined, options.store || options.exact !== false);
  const files = new Map<string, TreeEntry>();
  const next = new Map<string, IndexEntry>();
  const racyBefore = Date.now() - RACY_WINDOW_MS;

  const unchangedSince = (file: FolderFile): IndexEntry | null => {
    const known = index.get(file.path);
    return known &&
      known.size === file.size &&
      known.mtimeMs === file.mtimeMs &&
      (!options.store || known.chunks.length > 0 || file.size === 0)
      ? known
      : null;
  };

  /*
    The files that have to be read, handed to the native engine in one go when
    there are enough of them to be worth a process. It reads, hashes, cuts and
    compresses them on every core and gives the same names and chunks storeFile
    would; anything it does not answer is read here as before.
  */
  const toRead = listed.filter((file) => !unchangedSince(file));
  let native: Map<string, EngineStored & EngineMeasured> | null = null;
  let done = listed.length - toRead.length;
  const readBytes = toRead.reduce((sum, file) => sum + file.size, 0);
  /*
    Not to store into a v2 history: the engine writes v1 packs, so what it
    stored would miss the solid blocks and deltas. It still measures there.
  */
  if (worthTheEngine(toRead.length, readBytes) && !(options.store && repository.objects.v2)) {
    const report = options.progress
      ? (count: number, _total: number, file: string) => options.progress!(done + count, listed.length, file)
      : undefined;
    const wanted = toRead.map((file) => ({ path: file.path, size: file.size }));
    native = options.store
      ? await engineStore(repository.objects.directory, repository.root, wanted, report)
      : await engineMeasure(repository.root, wanted.map((file) => ({ path: file.path, count: false })), report);
    /* The engine wrote packs this store has not read yet. */
    if (native && options.store) repository.objects.rescan();
    if (native) done += toRead.filter((file) => native!.get(file.path)?.sha256).length;
  }

  /* What is already known about a file without reading it: from the index, or from the engine. */
  const answerFor = (file: FolderFile) => {
    const known = unchangedSince(file);
    if (known) return { sha256: known.sha256, chunks: known.chunks, settled: true, fromEngine: false };
    const answered = native?.get(file.path);
    if (answered && !answered.error && answered.sha256 && (!options.store || answered.chunks)) {
      return {
        sha256: answered.sha256,
        chunks: options.store ? answered.chunks! : [],
        /* Whether what was read is what was listed; a file still being written is not trusted next time. */
        settled: answered.size === file.size && (options.store || answered.mtimeMs === file.mtimeMs),
        fromEngine: true,
      };
    }
    return null;
  };
  const record = (file: FolderFile, sha256: string, chunks: string[], settled: boolean) => {
    const executable = executableFrom(file.mode, previous.get(file.path));
    files.set(file.path, {
      path: file.path,
      size: file.size,
      sha256,
      executable,
      chunks,
    });
    if (file.mtimeMs < racyBefore && settled) {
      next.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, sha256, chunks, executable });
    }
  };
  /*
    Everything already answered is recorded straight away; only files that
    still have to be read go through the lanes. A quiet status on a folder of
    eight thousand files spent fifty milliseconds queueing files that needed
    nothing done to them.
  */
  const toReadHere: FolderFile[] = [];
  for (const file of listed) {
    const answer = answerFor(file);
    if (!answer) {
      toReadHere.push(file);
      continue;
    }
    record(file, answer.sha256, answer.chunks, answer.settled);
    if (!answer.fromEngine) {
      done += 1;
      options.progress?.(done, listed.length, file.path);
    }
  }

  /*
    A new file is kept against the file most like it the last save held:
    one with the same extension in the same folder, nearest in size, and
    within a factor of two. A copy made and edited is then a few bytes.
  */
  let alike: Map<string, TreeEntry[]> | null = null;
  const kindOf = (filePath: string) => {
    const slash = filePath.lastIndexOf("/");
    const name = filePath.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    return `${filePath.slice(0, slash + 1)}\u0000${dot > 0 ? name.slice(dot).toLowerCase() : ""}`;
  };
  const hintsFor = (file: FolderFile): { previous?: TreeEntry; similar?: TreeEntry } => {
    const was = previous.get(file.path);
    if (was) return { previous: was };
    if (!alike) {
      alike = new Map();
      for (const entry of previous.values()) {
        if (entry.chunks.length !== 1) continue;
        const key = kindOf(entry.path);
        const list = alike.get(key);
        if (list) list.push(entry);
        else alike.set(key, [entry]);
      }
    }
    let best: TreeEntry | undefined;
    for (const entry of alike.get(kindOf(file.path)) ?? []) {
      if (entry.size * 2 < file.size || entry.size > file.size * 2) continue;
      if (!best || Math.abs(entry.size - file.size) < Math.abs(best.size - file.size)) best = entry;
    }
    return best ? { similar: best } : {};
  };

  const one = async (file: FolderFile): Promise<void> => {
    const full = path.join(repository.root, file.path);
    let sha256: string;
    let chunks: string[] = [];
    if (options.store) {
      ({ sha256, chunks } = await storeFile(
        repository,
        full,
        file.size,
        repository.objects.v2 ? { path: file.path, ...hintsFor(file) } : undefined,
      ));
    } else {
      sha256 = await digestFile(full, file.size);
    }
    record(file, sha256, chunks, true);
    done += 1;
    options.progress?.(done, listed.length, file.path);
  };
  const large = (file: FolderFile) => profileForFileSize(file.size) !== null;
  await Promise.all([
    inLanes(toReadHere.filter((file) => !large(file)), SMALL_LANES, one),
    inLanes(toReadHere.filter(large), LARGE_LANES, one),
  ]);
  /* Nothing may name an object that is not on disk yet. */
  /*
    A v2 history writes the files with the tree that names them, in one pack:
    the save flushes after its tree (writeTree), so a pack is not spent on
    the tree alone.
  */
  if (options.store && !repository.objects.v2) await repository.objects.flush();
  options.progress?.(listed.length, listed.length, "");
  const sameEntry = (left: IndexEntry, right: IndexEntry | undefined) =>
    Boolean(right) &&
    left.size === right!.size &&
    left.mtimeMs === right!.mtimeMs &&
    left.sha256 === right!.sha256 &&
    left.executable === right!.executable &&
    left.chunks.length === right!.chunks.length &&
    left.chunks.every((chunk, at) => chunk === right!.chunks[at]);
  const indexChanged = next.size !== index.size || [...next].some(([file, entry]) => !sameEntry(entry, index.get(file)));
  return { files, index: next, indexChanged };
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
