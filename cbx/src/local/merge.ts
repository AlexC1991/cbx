/**
 * Merging two lines of a local history.
 *
 * Every path is decided by comparing both sides with the save they last had
 * in common. A file only one side changed is taken from that side, a file
 * both changed the same way is taken once, and a text file both changed
 * differently is merged line by line. Only what is left after that is a
 * conflict: marked in the file for text, and for anything else left as this
 * side had it and named, so a person decides.
 *
 * A merge with no conflicts is saved at once with both saves as parents. One
 * with conflicts writes what it could into the folder and waits in
 * `.cbx/merge.json` until the person saves (which makes the merge save) or
 * cancels (which puts the folder back).
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hasConflictMarkers } from "../shared/merge_diff.js";
import type { Repository, Save, Tree, TreeEntry } from "./repository.js";
import { checkout, contentsOf, readFolder, sameFile } from "./snapshot.js";
import { mergeText } from "./merge_text.js";
import { UnsavedChanges } from "./errors.js";

/** Past this a file is not merged line by line. */
const TEXT_LIMIT = 4 * 1024 * 1024;

export type ConflictKind = "text" | "binary" | "deleted-here" | "deleted-there";

export type MergeState = {
  format: "cbx-merge";
  version: 1;
  /** The save being merged in. */
  theirs: string;
  base: string | null;
  message: string;
  /** Every path this merge changed in the folder, for cancelling it. */
  touched: string[];
  conflicts: Array<{ path: string; kind: ConflictKind }>;
};

export type MergeOutcome =
  | { kind: "up-to-date" }
  | { kind: "fast-forward"; save: Save; written: string[]; removed: string[] }
  | { kind: "merged"; save: Save; written: string[]; removed: string[] }
  | { kind: "conflicts"; state: MergeState; written: string[]; removed: string[] };

const MERGE_FILE = "merge.json";

export class MergeInProgress extends Error {}

export async function readMergeState(repository: Repository): Promise<MergeState | null> {
  try {
    return JSON.parse(await readFile(path.join(repository.directory, MERGE_FILE), "utf8")) as MergeState;
  } catch {
    return null;
  }
}

async function writeMergeState(repository: Repository, state: MergeState | null): Promise<void> {
  const target = path.join(repository.directory, MERGE_FILE);
  if (!state) {
    await rm(target, { force: true });
    return;
  }
  await writeFile(`${target}.partial`, JSON.stringify(state, null, 2));
  await rename(`${target}.partial`, target);
}

export async function clearMergeState(repository: Repository): Promise<void> {
  await writeMergeState(repository, null);
}

/** Every ancestor of `from`, itself included, through all parents. */
async function ancestors(repository: Repository, from: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(await repository.readSave(id)).parents);
  }
  return seen;
}

/** The nearest save both descend from, or null for unrelated histories. */
export async function mergeBase(repository: Repository, left: string, right: string): Promise<string | null> {
  const mine = await ancestors(repository, left);
  const seen = new Set<string>();
  const queue = [right];
  while (queue.length) {
    const id = queue.shift()!;
    if (mine.has(id)) return id;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(await repository.readSave(id)).parents);
  }
  return null;
}

export async function isAncestor(repository: Repository, ancestor: string, of: string): Promise<boolean> {
  return (await ancestors(repository, of)).has(ancestor);
}

const byPath = (tree: Tree) => new Map(tree.files.map((file) => [file.path, file]));

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/**
 * Merge the save `theirs` into the folder's line. Assumes the lock is held;
 * `merge` in history.ts is the public way in.
 */
export async function mergeInto(
  repository: Repository,
  theirs: string,
  options: { message: string; author: string; label: string; now?: Date },
): Promise<MergeOutcome> {
  if (await readMergeState(repository)) {
    throw new MergeInProgress(
      "A merge is already waiting on conflicts. Resolve them and save, or cancel it with cbx merge --cancel.",
    );
  }
  const line = await repository.currentLine();
  const ours = await repository.head();
  const theirSave = await repository.readSave(theirs);
  const theirTree = await repository.readTree(theirSave.tree);
  const oursTree: Tree = ours
    ? await repository.readTree((await repository.readSave(ours)).tree)
    : { format: "cbx-tree", version: 1, files: [] };
  const mine = byPath(oursTree);
  const other = byPath(theirTree);

  if (ours && (ours === theirs || (await isAncestor(repository, theirs, ours)))) {
    return { kind: "up-to-date" };
  }

  const reading = await readFolder(repository, { store: false, previous: oursTree });
  /* Unsaved work is never overwritten; only the files a merge changes are checked. */
  const guard = (touched: Set<string>) => {
    const blocked: string[] = [];
    for (const file of touched) {
      const now = reading.files.get(file);
      if (!now) {
        if (mine.has(file)) blocked.push(file);
        continue;
      }
      if (!sameFile(now, mine.get(file))) blocked.push(file);
    }
    if (blocked.length) {
      throw new UnsavedChanges(blocked.sort(), "Merging", "Save them or put them back first, then merge again.");
    }
  };

  if (!ours || (await isAncestor(repository, ours, theirs))) {
    const touched = new Set(
      [...mine.keys(), ...other.keys()].filter((file) => !sameFile(mine.get(file), other.get(file))),
    );
    guard(touched);
    const done = await checkout(repository, reading.files, theirTree, (file) => touched.has(file));
    await repository.setLineTip(line, theirs);
    return { kind: "fast-forward", save: theirSave, ...done };
  }

  const baseId = await mergeBase(repository, ours, theirs);
  const base = baseId
    ? byPath(await repository.readTree((await repository.readSave(baseId)).tree))
    : new Map<string, TreeEntry>();

  const result = new Map<string, TreeEntry>();
  const conflicts: MergeState["conflicts"] = [];
  const labels = { ours: `${line} (this history)`, theirs: options.label };
  const paths = new Set([...base.keys(), ...mine.keys(), ...other.keys()]);

  for (const file of [...paths].sort()) {
    const b = base.get(file);
    const o = mine.get(file);
    const t = other.get(file);
    const settled = (entry: TreeEntry | undefined) => {
      if (entry) result.set(file, entry);
    };
    if (sameFile(o, t) || (!o && !t)) {
      settled(o);
      continue;
    }
    if (sameFile(b, o) || (!b && !o)) {
      settled(t);
      continue;
    }
    if (sameFile(b, t) || (!b && !t)) {
      settled(o);
      continue;
    }
    /* Only the execute bit differs on one side: take the content once, and that bit. */
    if (o && t && o.sha256 === t.sha256) {
      settled({ ...o, executable: b && b.executable !== o.executable ? o.executable : t.executable });
      continue;
    }
    if (!o || !t) {
      /* Changed on one side, deleted on the other: keep the changed file and ask. */
      settled(o ?? t);
      conflicts.push({ path: file, kind: o ? "deleted-there" : "deleted-here" });
      continue;
    }
    const tooBig = Math.max(o.size, t.size, b?.size ?? 0) > TEXT_LIMIT;
    const ourBytes = tooBig ? null : await contentsOf(repository, o);
    const theirBytes = tooBig ? null : await contentsOf(repository, t);
    const baseBytes = tooBig || !b ? Buffer.alloc(0) : await contentsOf(repository, b);
    if (!ourBytes || !theirBytes || looksBinary(ourBytes) || looksBinary(theirBytes) || looksBinary(baseBytes)) {
      settled(o);
      conflicts.push({ path: file, kind: "binary" });
      continue;
    }
    const merged = mergeText(
      baseBytes.toString("utf8"),
      ourBytes.toString("utf8"),
      theirBytes.toString("utf8"),
      labels,
    );
    const text = merged?.text ?? (
      `<<<<<<< ${labels.ours}\n${ourBytes.toString("utf8")}\n=======\n${theirBytes.toString("utf8")}\n>>>>>>> ${labels.theirs}\n`
    );
    const bytes = Buffer.from(text, "utf8");
    const digest = await repository.objects.put(bytes);
    settled({
      path: file,
      size: bytes.length,
      sha256: digest,
      executable: o.executable,
      chunks: bytes.length ? [digest] : [],
    });
    if (!merged || merged.conflicts) conflicts.push({ path: file, kind: "text" });
  }
  await repository.objects.flush();

  const mergedTree: Tree = { format: "cbx-tree", version: 1, files: [...result.values()] };
  const touched = new Set(
    [...mine.keys(), ...result.keys()].filter((file) => !sameFile(mine.get(file), result.get(file))),
  );
  guard(touched);
  const done = await checkout(repository, reading.files, mergedTree, (file) => touched.has(file));

  if (conflicts.length) {
    const state: MergeState = {
      format: "cbx-merge",
      version: 1,
      theirs,
      base: baseId,
      message: options.message,
      touched: [...touched].sort(),
      conflicts,
    };
    await writeMergeState(repository, state);
    return { kind: "conflicts", state, ...done };
  }

  const tree = await repository.writeTree(mergedTree.files);
  const save = await repository.writeSave({
    format: "cbx-save",
    version: 1,
    tree,
    parents: [ours, theirs],
    line,
    message: options.message,
    author: options.author,
    created: (options.now ?? new Date()).toISOString(),
  });
  await repository.setLineTip(line, save.id);
  /* The files just written are racy; the next status reads them again, once. */
  return { kind: "merged", save, ...done };
}

/** Conflicted text files that still carry markers in the folder. */
export async function unresolved(repository: Repository, state: MergeState): Promise<string[]> {
  const left: string[] = [];
  for (const conflict of state.conflicts) {
    if (conflict.kind !== "text") continue;
    try {
      const text = await readFile(path.join(repository.root, conflict.path), "utf8");
      if (hasConflictMarkers(text)) left.push(conflict.path);
    } catch {
      /* Deleted is a decision too. */
    }
  }
  return left;
}

/** Settle conflicted files by taking one side whole. */
export async function takeSide(
  repository: Repository,
  side: "mine" | "theirs",
  only?: (file: string) => boolean,
): Promise<string[]> {
  const state = await readMergeState(repository);
  if (!state) throw new Error("No merge is waiting on conflicts.");
  const source = side === "mine" ? await repository.head() : state.theirs;
  const tree = source
    ? await repository.readTree((await repository.readSave(source)).tree)
    : ({ format: "cbx-tree", version: 1, files: [] } as Tree);
  const wanted = new Set(state.conflicts.map((one) => one.path).filter((file) => !only || only(file)));
  if (!wanted.size) throw new Error("None of the conflicts is at that path.");
  const reading = await readFolder(repository, { store: false, previous: tree });
  await checkout(repository, reading.files, tree, (file) => wanted.has(file));
  /* A side that does not hold the file settles it by removing it. */
  for (const file of wanted) {
    if (!tree.files.some((entry) => entry.path === file)) {
      await rm(path.join(repository.root, file), { force: true });
    }
  }
  state.conflicts = state.conflicts.filter((one) => !wanted.has(one.path));
  await writeMergeState(repository, state);
  return [...wanted].sort();
}
