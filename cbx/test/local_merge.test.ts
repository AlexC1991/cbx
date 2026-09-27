/**
 * Merging in a local history: the text merge on its own, then whole lines.
 *
 * The rules that matter: what only one side changed is taken without asking;
 * only what both changed differently is a conflict; a conflict never costs
 * either side's work; and unsaved work in the folder is never overwritten.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cancelMerge,
  init,
  log,
  merge,
  resolveConflicts,
  save,
  status,
  switchLine,
  UnresolvedConflicts,
  UnsavedChanges,
} from "../dist/local/history.js";
import { mergeBase } from "../dist/local/merge.js";
import { mergeText } from "../dist/local/merge_text.js";

/* ---- the text merge -------------------------------------------------- */

test("changes to different lines are both kept", () => {
  const base = "one\ntwo\nthree\nfour\nfive\n";
  const ours = "ONE\ntwo\nthree\nfour\nfive\n";
  const theirs = "one\ntwo\nthree\nfour\nFIVE\n";
  assert.deepEqual(mergeText(base, ours, theirs), { text: "ONE\ntwo\nthree\nfour\nFIVE\n", conflicts: 0 });
});

test("insertions on both sides at different places are both kept", () => {
  const base = "a\nb\nc\n";
  const merged = mergeText(base, "start\na\nb\nc\n", "a\nb\nc\nend\n");
  assert.deepEqual(merged, { text: "start\na\nb\nc\nend\n", conflicts: 0 });
});

test("the same change on both sides is taken once", () => {
  const merged = mergeText("a\nb\n", "a\nB\n", "a\nB\n");
  assert.deepEqual(merged, { text: "a\nB\n", conflicts: 0 });
});

test("different changes to the same line are marked, with both sides whole", () => {
  const merged = mergeText("x = 1\ny = 2\n", "x = 10\ny = 2\n", "x = 100\ny = 2\n", {
    ours: "main",
    theirs: "feature",
  })!;
  assert.equal(merged.conflicts, 1);
  assert.equal(merged.text, "<<<<<<< main\nx = 10\n=======\nx = 100\n>>>>>>> feature\ny = 2\n");
});

test("edits to neighbouring lines conflict, as they do in git", () => {
  /*
    Found in the live round trip and kept on purpose: with no unchanged line
    between them, the two edits are one region, and choosing an order for
    them would be a guess about what the file means.
  */
  const merged = mergeText("speed = 1\njump = 1\n", "speed = 5\njump = 1\n", "speed = 1\njump = 2\n")!;
  assert.equal(merged.conflicts, 1);
});

test("line endings are kept as each file had them", () => {
  const merged = mergeText("a\r\nb\r\nc\r\n", "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n")!;
  assert.deepEqual(merged, { text: "A\r\nb\r\nC\r\n", conflicts: 0 });
});

test("a deletion on one side and an untouched line on the other is a deletion", () => {
  const merged = mergeText("a\nb\nc\n", "a\nc\n", "a\nb\nc\nd\n");
  assert.deepEqual(merged, { text: "a\nc\nd\n", conflicts: 0 });
});

test("a last line with no newline does not swallow a marker", () => {
  const merged = mergeText("v1", "v2", "v3")!;
  assert.equal(merged.conflicts, 1);
  assert.equal(merged.text, "<<<<<<< ours\nv2\n=======\nv3\n>>>>>>> theirs\n");
});

/* ---- merging lines --------------------------------------------------- */

async function project(files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-merge-"));
  for (const [name, contents] of Object.entries(files)) await put(root, name, contents);
  return root;
}

async function put(root: string, name: string, contents: string | Buffer): Promise<void> {
  const full = path.join(root, name);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  const past = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 10_000));
  await utimes(full, past, past);
}

const read = (root: string, name: string) => readFile(path.join(root, name), "utf8");
const gone = async (root: string, name: string) =>
  stat(path.join(root, name)).then(() => false, () => true);

/** main and feature, each with its own saves since they parted. */
async function forked(
  start: Record<string, string | Buffer>,
  onFeature: (root: string) => Promise<void>,
  onMain: (root: string) => Promise<void>,
) {
  const root = await project(start);
  const repository = await init(root);
  await save(repository, { message: "start", author: "t" });
  await switchLine(repository, "feature", { create: true });
  await onFeature(root);
  await save(repository, { message: "feature work", author: "t" });
  await switchLine(repository, "main");
  await onMain(root);
  await save(repository, { message: "main work", author: "t" });
  return { root, repository };
}

test("a clean merge is saved at once, with both saves as parents", async () => {
  const { root, repository } = await forked(
    { "a.txt": "1\n2\n3\n", "b.txt": "b\n", "old.txt": "old\n" },
    async (at) => {
      await put(at, "a.txt", "1\n2\nTHREE\n");
      await put(at, "feature.txt", "new on feature\n");
    },
    async (at) => {
      await put(at, "a.txt", "ONE\n2\n3\n");
      await rm(path.join(at, "old.txt"));
    },
  );
  try {
    const outcome = await merge(repository, "feature");
    assert.equal(outcome.kind, "merged");
    if (outcome.kind !== "merged") return;
    assert.equal(outcome.save.parents.length, 2);
    assert.equal(await read(root, "a.txt"), "ONE\n2\nTHREE\n");
    assert.equal(await read(root, "feature.txt"), "new on feature\n");
    assert.ok(await gone(root, "old.txt"));
    assert.deepEqual((await status(repository)).changes, { added: [], modified: [], deleted: [] });
    assert.equal((await log(repository))[0]!.message, "Merge feature into main");
    /* Merging it again changes nothing. */
    assert.equal((await merge(repository, "feature")).kind, "up-to-date");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a line with nothing of its own simply moves forward", async () => {
  const root = await project({ "a.txt": "a\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "start", author: "t" });
    await switchLine(repository, "feature", { create: true });
    await put(root, "a.txt", "changed\n");
    const ahead = await save(repository, { message: "ahead", author: "t" });
    await switchLine(repository, "main");
    const outcome = await merge(repository, "feature");
    assert.equal(outcome.kind, "fast-forward");
    assert.ok(ahead.saved);
    if (!ahead.saved) return;
    assert.equal(await repository.head(), ahead.save.id);
    assert.equal(await read(root, "a.txt"), "changed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicts wait for a decision, and saving finishes the merge", async () => {
  const { root, repository } = await forked(
    { "a.txt": "x = 1\n", "clean.txt": "c\n" },
    async (at) => {
      await put(at, "a.txt", "x = 2\n");
      await put(at, "clean.txt", "from feature\n");
    },
    async (at) => put(at, "a.txt", "x = 3\n"),
  );
  try {
    const before = await repository.head();
    const outcome = await merge(repository, "feature");
    assert.equal(outcome.kind, "conflicts");
    assert.equal(await repository.head(), before);
    assert.match(await read(root, "a.txt"), /<<<<<<< main[\s\S]*x = 3[\s\S]*=======[\s\S]*x = 2[\s\S]*>>>>>>> feature/);
    assert.equal(await read(root, "clean.txt"), "from feature\n");
    assert.deepEqual((await status(repository)).merging?.unresolved, ["a.txt"]);

    await assert.rejects(save(repository, { message: "", author: "t" }), UnresolvedConflicts);
    await assert.rejects(switchLine(repository, "feature"), /merge is waiting/);

    await put(root, "a.txt", "x = 5\n");
    const done = await save(repository, { message: "", author: "t" });
    assert.ok(done.saved);
    if (!done.saved) return;
    assert.equal(done.save.parents.length, 2);
    assert.equal(done.save.message, "Merge feature into main");
    assert.equal((await status(repository)).merging, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("taking a side settles a conflict, and a merge that keeps one side whole still saves", async () => {
  const { root, repository } = await forked(
    { "a.txt": "base\n" },
    async (at) => put(at, "a.txt", "theirs\n"),
    async (at) => put(at, "a.txt", "mine\n"),
  );
  try {
    await merge(repository, "feature");
    await resolveConflicts(repository, "mine");
    assert.equal(await read(root, "a.txt"), "mine\n");
    const done = await save(repository, { message: "keep mine", author: "t" });
    assert.ok(done.saved, "a merge save is made even when the files equal this line's");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling puts back every file the merge changed", async () => {
  const { root, repository } = await forked(
    { "a.txt": "base\n", "b.txt": "b\n" },
    async (at) => {
      await put(at, "a.txt", "theirs\n");
      await put(at, "b.txt", "b from feature\n");
    },
    async (at) => put(at, "a.txt", "mine\n"),
  );
  try {
    await merge(repository, "feature");
    assert.equal(await read(root, "b.txt"), "b from feature\n");
    await cancelMerge(repository);
    assert.equal(await read(root, "a.txt"), "mine\n");
    assert.equal(await read(root, "b.txt"), "b\n");
    assert.equal((await status(repository)).merging, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary files and change-against-delete are conflicts that keep a whole file", async () => {
  const { root, repository } = await forked(
    { "art.bin": Buffer.from([0, 1, 2]), "doc.txt": "doc\n" },
    async (at) => {
      await put(at, "art.bin", Buffer.from([0, 9, 9]));
      await rm(path.join(at, "doc.txt"));
    },
    async (at) => {
      await put(at, "art.bin", Buffer.from([0, 7, 7]));
      await put(at, "doc.txt", "doc, edited on main\n");
    },
  );
  try {
    const outcome = await merge(repository, "feature");
    assert.equal(outcome.kind, "conflicts");
    if (outcome.kind !== "conflicts") return;
    assert.deepEqual(
      outcome.state.conflicts.map((one) => `${one.path}:${one.kind}`).sort(),
      ["art.bin:binary", "doc.txt:deleted-there"],
    );
    assert.deepEqual([...(await readFile(path.join(root, "art.bin")))], [0, 7, 7]);
    assert.equal(await read(root, "doc.txt"), "doc, edited on main\n");
    await resolveConflicts(repository, "theirs", (file) => file === "art.bin");
    assert.deepEqual([...(await readFile(path.join(root, "art.bin")))], [0, 9, 9]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsaved work in a file the merge changes stops it before anything moves", async () => {
  const { root, repository } = await forked(
    { "a.txt": "a\n", "b.txt": "b\n" },
    async (at) => put(at, "a.txt", "a from feature\n"),
    async (at) => put(at, "b.txt", "b on main\n"),
  );
  try {
    await put(root, "a.txt", "unsaved\n");
    await assert.rejects(merge(repository, "feature"), UnsavedChanges);
    assert.equal(await read(root, "a.txt"), "unsaved\n");
    assert.equal((await status(repository)).merging, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the merge base is the nearest save both lines share", async () => {
  const { root, repository } = await forked(
    { "a.txt": "a\n" },
    async (at) => put(at, "a.txt", "f\n"),
    async (at) => put(at, "b.txt", "m\n"),
  );
  try {
    const start = (await log(repository, { from: "main~1" }))[0]!;
    const base = await mergeBase(repository, (await repository.resolve("main")).id, (await repository.resolve("feature")).id);
    assert.equal(base, start.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
