/**
 * What `cbx init`, `save`, `log`, `status`, `diff`, `restore` and `switch` do,
 * without the printing. Everything here works with no network at all.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  diffLines,
  foldUnchanged,
  linesOf,
  type DiffChunk,
  type DiffLine,
} from "../shared/merge_diff.js";
import {
  DEFAULT_LINE,
  lineNameProblem,
  Repository,
  type Save,
  type Tree,
  type TreeEntry,
} from "./repository.js";
import { checkout, contentsOf, inLanes, readFolder, sameFile, type Progress } from "./snapshot.js";
import { UnresolvedConflicts, UnsavedChanges } from "./errors.js";
import {
  clearMergeState,
  mergeInto,
  readMergeState,
  takeSide,
  unresolved,
  type MergeOutcome,
  type MergeState,
} from "./merge.js";

export { Repository } from "./repository.js";
export { UnresolvedConflicts, UnsavedChanges } from "./errors.js";
export type { MergeOutcome, MergeState } from "./merge.js";

const EMPTY_TREE: Tree = { format: "cbx-tree", version: 1, files: [] };

/** Past this a file is described, not diffed line by line. */
const DIFF_BYTE_LIMIT = 4 * 1024 * 1024;

export type Changes = { added: string[]; modified: string[]; deleted: string[] };

export function compareTrees(before: Map<string, TreeEntry>, after: Map<string, TreeEntry>): Changes {
  const changes: Changes = { added: [], modified: [], deleted: [] };
  for (const [file, entry] of after) {
    const was = before.get(file);
    if (!was) changes.added.push(file);
    else if (!sameFile(was, entry)) changes.modified.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) changes.deleted.push(file);
  for (const list of Object.values(changes)) list.sort();
  return changes;
}

export function byPath(tree: Tree): Map<string, TreeEntry> {
  return new Map(tree.files.map((file) => [file.path, file]));
}

export function changeCount(changes: Changes): number {
  return changes.added.length + changes.modified.length + changes.deleted.length;
}

/**
 * A filter for paths the user named, relative to the history's root.
 *
 * A name matches itself and everything under it, so naming a folder names
 * its contents. `.` or the root itself names everything.
 */
export function pathFilter(
  repository: Repository,
  names: string[],
  cwd = process.cwd(),
): ((file: string) => boolean) | undefined {
  if (!names.length) return undefined;
  const wanted = names.map((name) => {
    const relative = path
      .relative(repository.root, path.resolve(cwd, name))
      .split(path.sep)
      .join("/");
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${name} is outside this project.`);
    }
    return relative;
  });
  if (wanted.some((one) => one === "")) return undefined;
  return (file) => wanted.some((one) => file === one || file.startsWith(`${one}/`));
}

export async function headTree(repository: Repository): Promise<{ save: Save | null; tree: Tree }> {
  const head = await repository.head();
  if (!head) return { save: null, tree: EMPTY_TREE };
  const save = await repository.readSave(head);
  return { save, tree: await repository.readTree(save.tree) };
}

/* ---- init ------------------------------------------------------------ */

export async function init(root: string, line = DEFAULT_LINE): Promise<Repository> {
  return Repository.init(root, line);
}

/* ---- save ------------------------------------------------------------ */

export type SaveResult =
  | { saved: true; save: Save; changes: Changes; files: number; bytes: number }
  | { saved: false; reason: "unchanged" };

/**
 * Record the folder as it is now, on the current line.
 *
 * A save identical to the last one is refused rather than made, because a
 * history of saves that each say nothing happened is noise.
 */
export async function save(
  repository: Repository,
  options: { message: string; author?: string; progress?: Progress; now?: Date; force?: boolean },
): Promise<SaveResult> {
  return repository.locked(async () => {
    /*
      A merge waiting on conflicts is finished by saving: the save gets both
      parents, may say nothing new (keeping one side whole is a decision), and
      takes the merge's own message when given none.
    */
    const merging = await readMergeState(repository);
    const message = options.message.trim() || merging?.message || "";
    if (!message) throw new Error("A save needs a message saying what changed.");
    if (merging && !options.force) {
      const left = await unresolved(repository, merging);
      if (left.length) throw new UnresolvedConflicts(left);
    }
    const { save: parent, tree: before } = await headTree(repository);
    const reading = await readFolder(repository, {
      store: true,
      previous: before,
      progress: options.progress,
    });
    const tree = await repository.writeTree([...reading.files.values()]);
    await repository.writeIndex(reading.index);
    if (!merging && parent && parent.tree === tree) {
      return { saved: false, reason: "unchanged" } as const;
    }

    const line = await repository.currentLine();
    const parents = parent ? [parent.id] : [];
    if (merging) parents.push(merging.theirs);
    const made = await repository.writeSave({
      format: "cbx-save",
      version: 1,
      tree,
      parents,
      line,
      message,
      author: options.author ?? (await repository.author()),
      created: (options.now ?? new Date()).toISOString(),
    });
    await repository.setLineTip(line, made.id);
    if (merging) await clearMergeState(repository);
    let bytes = 0;
    for (const file of reading.files.values()) bytes += file.size;
    return {
      saved: true,
      save: made,
      changes: compareTrees(byPath(before), reading.files),
      files: reading.files.size,
      bytes,
    } as const;
  });
}

/* ---- log ------------------------------------------------------------- */

/** Saves newest first, following each save's first parent. */
export async function log(
  repository: Repository,
  options: { from?: string; limit?: number } = {},
): Promise<Save[]> {
  const limit = options.limit ?? Infinity;
  const found: Save[] = [];
  let at: Save | null;
  if (options.from) {
    at = await repository.resolve(options.from);
  } else {
    const head = await repository.head();
    at = head ? await repository.readSave(head) : null;
  }
  while (at && found.length < limit) {
    found.push(at);
    const parent: string | undefined = at.parents[0];
    at = parent ? await repository.readSave(parent) : null;
  }
  return found;
}

/* ---- status ---------------------------------------------------------- */

export type Status = {
  line: string;
  head: Save | null;
  changes: Changes;
  /** Set while a merge waits on conflicts. */
  merging?: { theirs: string; conflicts: MergeState["conflicts"]; unresolved: string[] };
};

export async function status(repository: Repository): Promise<Status> {
  const { save: head, tree } = await headTree(repository);
  const reading = await readFolder(repository, { store: false, previous: tree });
  /*
    Kept, so the next status does not hash the same files again. The index
    is only a cache: an entry this writes without objects makes a save read
    that file once more, never trust something it has not stored.
  */
  await repository.writeIndex(reading.index);
  const merging = await readMergeState(repository);
  return {
    line: await repository.currentLine(),
    head,
    changes: compareTrees(byPath(tree), reading.files),
    ...(merging
      ? {
          merging: {
            theirs: merging.theirs,
            conflicts: merging.conflicts,
            unresolved: await unresolved(repository, merging),
          },
        }
      : {}),
  };
}

/* ---- diff ------------------------------------------------------------ */

export type FileDiff = {
  path: string;
  kind: "added" | "modified" | "deleted";
  /** Set when the change is described rather than shown: binary, or too big. */
  summary?: string;
  chunks?: DiffChunk[];
  executableChanged?: boolean;
};

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/**
 * What changed between two states of the project.
 *
 * `from` defaults to the last save and `to` to the folder as it is, so with
 * neither it answers "what have I changed since I last saved".
 */
export async function diff(
  repository: Repository,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  try {
    return await diffBetween(repository, options);
  } finally {
    await repository.objects.release();
  }
}

type DiffOptions = { from?: string; to?: string; only?: (file: string) => boolean; context?: number };

async function diffBetween(repository: Repository, options: DiffOptions): Promise<FileDiff[]> {
  const beforeTree = options.from
    ? await repository.readTree((await repository.resolve(options.from)).tree)
    : (await headTree(repository)).tree;
  const before = byPath(beforeTree);
  let after: Map<string, TreeEntry>;
  let afterIsFolder = false;
  if (options.to) {
    after = byPath(await repository.readTree((await repository.resolve(options.to)).tree));
  } else {
    after = (await readFolder(repository, { store: false, previous: beforeTree })).files;
    afterIsFolder = true;
  }

  const bytesOf = async (entry: TreeEntry, fromFolder: boolean): Promise<Buffer> =>
    fromFolder
      ? readFile(path.join(repository.root, entry.path))
      : contentsOf(repository, entry);

  const changes = compareTrees(before, after);
  const results: FileDiff[] = [];
  const kinds: Array<[FileDiff["kind"], string[]]> = [
    ["added", changes.added],
    ["modified", changes.modified],
    ["deleted", changes.deleted],
  ];
  const ordered = kinds
    .flatMap(([kind, files]) => files.map((file) => ({ kind, file })))
    .filter(({ file }) => !options.only || options.only(file))
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));

  for (const { kind, file } of ordered) {
    const was = before.get(file);
    const now = after.get(file);
    const result: FileDiff = { path: file, kind };
    if (was && now && was.sha256 === now.sha256) {
      result.executableChanged = true;
      result.chunks = [];
      results.push(result);
      continue;
    }
    const size = Math.max(was?.size ?? 0, now?.size ?? 0);
    if (size > DIFF_BYTE_LIMIT) {
      result.summary = `${describeSize(was?.size)} → ${describeSize(now?.size)}, too large to show line by line`;
      results.push(result);
      continue;
    }
    const left = was ? await bytesOf(was, false) : Buffer.alloc(0);
    const right = now ? await bytesOf(now, afterIsFolder) : Buffer.alloc(0);
    if (looksBinary(left) || looksBinary(right)) {
      result.summary = `binary, ${describeSize(was?.size)} → ${describeSize(now?.size)}`;
      results.push(result);
      continue;
    }
    if (was && now) result.executableChanged = was.executable !== now.executable;
    const lines = lineDiff(left.toString("utf8"), right.toString("utf8"));
    if (!lines) {
      result.summary = "too many lines changed to show line by line";
      results.push(result);
      continue;
    }
    result.chunks = foldUnchanged(lines, options.context ?? 3);
    results.push(result);
  }
  return results;
}

/*
  The most comparison cells the line diff may fill.

  The shared diff is an exact longest-common-subsequence table, which is the
  right call for a merge conflict and quadratic in memory. Lines both sides
  share at the start and end are taken off first, so an ordinary edit costs
  almost nothing; past this, the change is described instead.
*/
const DIFF_CELL_LIMIT = 4_000_000;

/** Lines in order, or null when the files differ too widely to compare. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const left = linesOf(before);
  const right = linesOf(after);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (
    end < left.length - start &&
    end < right.length - start &&
    left[left.length - 1 - end] === right[right.length - 1 - end]
  ) {
    end += 1;
  }
  const middleLeft = left.slice(start, left.length - end);
  const middleRight = right.slice(start, right.length - end);
  if ((middleLeft.length + 1) * (middleRight.length + 1) > DIFF_CELL_LIMIT) return null;

  const same = (a: number, b: number): DiffLine => ({
    side: "same",
    targetLine: a + 1,
    candidateLine: b + 1,
    text: left[a]!,
  });
  const out: DiffLine[] = [];
  for (let at = 0; at < start; at += 1) out.push(same(at, at));
  /* Every line newline-ended, so an empty line survives the round trip. */
  const joined = (lines: string[]) => lines.map((line) => `${line}\n`).join("");
  for (const line of diffLines(joined(middleLeft), joined(middleRight))) {
    out.push({
      ...line,
      targetLine: line.targetLine === null ? null : line.targetLine + start,
      candidateLine: line.candidateLine === null ? null : line.candidateLine + start,
    });
  }
  for (let at = 0; at < end; at += 1) {
    out.push(same(left.length - end + at, right.length - end + at));
  }
  return out;
}

function describeSize(size: number | undefined): string {
  if (size === undefined) return "nothing";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/* ---- restore and switch ---------------------------------------------- */

/**
 * Unsaved changes among the files a checkout will rewrite or delete.
 *
 * A file that is missing from the folder is never in the way: putting it
 * back loses nothing. Nor is one that already holds what the checkout would
 * write. Anything else that differs from the last save would be lost.
 */
export function inTheWay(
  current: Map<string, TreeEntry>,
  head: Map<string, TreeEntry>,
  target: Map<string, TreeEntry>,
  touched: Set<string>,
): string[] {
  const blocked: string[] = [];
  for (const file of touched) {
    const now = current.get(file);
    if (!now) continue;
    if (sameFile(now, head.get(file)) || sameFile(now, target.get(file))) continue;
    blocked.push(file);
  }
  return blocked.sort();
}

/**
 * Files the checkout would write over that the folder reading never saw.
 *
 * The reading lists only what the ignore rules let through, so a file the
 * rules now leave out but a save still holds would be written over with no
 * check at all. Those are looked at on disk directly.
 */
export async function hiddenInTheWay(
  repository: Repository,
  current: Map<string, TreeEntry>,
  target: Map<string, TreeEntry>,
  touched: Set<string>,
): Promise<string[]> {
  const blocked: string[] = [];
  const unseen = [...touched].filter((file) => target.has(file) && !current.has(file));
  await inLanes(unseen, 16, async (file) => {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(repository.root, file));
    } catch {
      return;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== target.get(file)!.sha256) {
      blocked.push(file);
    }
  });
  return blocked;
}

export type RestoreResult = { save: Save; written: string[]; removed: string[] };

/**
 * Put files back the way a save had them. The line does not move: this
 * changes the folder, and the next save records whatever it now holds.
 */
export async function restore(
  repository: Repository,
  options: { from?: string; only?: (file: string) => boolean; force?: boolean } = {},
): Promise<RestoreResult> {
  return repository.locked(async () => {
    const source = await repository.resolve(options.from ?? "HEAD");
    const target = await repository.readTree(source.tree);
    const { tree: headSaved } = await headTree(repository);
    const reading = await readFolder(repository, { store: false, previous: headSaved });
    const saved = byPath(headSaved);
    const wanted = byPath(target);
    /*
      Every file either save holds, within the paths named. Files neither
      holds are none of the history's business and are never touched.
    */
    const touched = new Set(
      [...saved.keys(), ...wanted.keys()].filter((file) => !options.only || options.only(file)),
    );
    if (!options.force) {
      const blocked = [
        ...inTheWay(reading.files, saved, wanted, touched),
        ...(await hiddenInTheWay(repository, reading.files, wanted, touched)),
      ].sort();
      if (blocked.length) throw new UnsavedChanges(blocked, "Restoring");
    }
    /*
      Compared with what is on disk, not what was saved, so a file with
      unsaved changes is rewritten and one that already matches is not.
    */
    const done = await checkout(repository, reading.files, target, (file) => touched.has(file));
    return { save: source, ...done };
  });
}

export type SwitchResult = {
  line: string;
  created: boolean;
  save: Save | null;
  written: string[];
  removed: string[];
};

/**
 * Move the folder to another line of work, or start one with `create`.
 *
 * A new line begins at the current save and changes no files. Moving to an
 * existing line rewrites only the files that differ between the two, and
 * unsaved changes to those files stop it unless `force` is given.
 */
export async function switchLine(
  repository: Repository,
  line: string,
  options: { create?: boolean; force?: boolean } = {},
): Promise<SwitchResult> {
  const problem = lineNameProblem(line);
  if (problem) throw new Error(`Cannot name a line "${line}": ${problem}.`);
  return repository.locked(async () => {
    if (await readMergeState(repository)) {
      throw new Error("A merge is waiting on conflicts. Finish it with cbx save, or cancel it with cbx merge --cancel.");
    }
    const current = await repository.currentLine();
    if (options.create) {
      if (await repository.lineExists(line)) {
        throw new Error(`There is already a line called ${line}. Leave out -c to switch to it.`);
      }
      const head = await repository.head();
      if (head) await repository.setLineTip(line, head);
      await repository.setCurrentLine(line);
      return {
        line,
        created: true,
        save: head ? await repository.readSave(head) : null,
        written: [],
        removed: [],
      };
    }
    if (line === current) {
      throw new Error(`Already on ${line}.`);
    }
    const tip = await repository.lineTip(line);
    if (!tip) throw new Error(`No line called ${line}. Add -c to start one here.`);
    const targetSave = await repository.readSave(tip);
    const target = await repository.readTree(targetSave.tree);
    const { tree: headSaved } = await headTree(repository);
    const reading = await readFolder(repository, { store: false, previous: headSaved });
    const saved = byPath(headSaved);
    const wanted = byPath(target);
    /*
      Only files the two lines disagree about. An edit to a file both lines
      hold alike comes along to the new line untouched, as it does in git.
    */
    const touched = new Set(
      [...saved.keys(), ...wanted.keys()].filter(
        (file) => !sameFile(saved.get(file), wanted.get(file)),
      ),
    );
    if (!options.force) {
      const blocked = [
        ...inTheWay(reading.files, saved, wanted, touched),
        ...(await hiddenInTheWay(repository, reading.files, wanted, touched)),
      ].sort();
      if (blocked.length) throw new UnsavedChanges(blocked, `Switching to ${line}`);
    }
    const done = await checkout(repository, reading.files, target, (file) => touched.has(file));
    await repository.setCurrentLine(line);
    return { line, created: false, save: targetSave, ...done };
  });
}

/* ---- merge ------------------------------------------------------------ */

/**
 * Merge another line, or any save, into the folder's line.
 *
 * Moves the line straight to it when this line has nothing of its own, and
 * does nothing when it is already included. Otherwise see merge.ts.
 */
export async function merge(
  repository: Repository,
  other: string,
  options: { message?: string; author?: string; now?: Date } = {},
): Promise<MergeOutcome> {
  return repository.locked(async () => {
    const theirs = await repository.resolve(other);
    const line = await repository.currentLine();
    return mergeInto(repository, theirs.id, {
      message: options.message?.trim() || `Merge ${other} into ${line}`,
      author: options.author ?? (await repository.author()),
      label: other,
      now: options.now,
    });
  });
}

/** Call a waiting merge off and put back every file it changed. */
export async function cancelMerge(repository: Repository): Promise<string[]> {
  return repository.locked(async () => {
    const state = await readMergeState(repository);
    if (!state) throw new Error("No merge is waiting.");
    const { tree } = await headTree(repository);
    const touched = new Set(state.touched);
    const reading = await readFolder(repository, { store: false, previous: tree });
    const done = await checkout(repository, reading.files, tree, (file) => touched.has(file));
    await clearMergeState(repository);
    return [...done.written, ...done.removed].sort();
  });
}

/** Settle conflicts by taking this line's side or the other's, whole. */
export async function resolveConflicts(
  repository: Repository,
  side: "mine" | "theirs",
  only?: (file: string) => boolean,
): Promise<string[]> {
  return repository.locked(() => takeSide(repository, side, only));
}
