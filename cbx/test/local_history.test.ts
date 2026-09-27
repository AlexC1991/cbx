/**
 * The local history: `.cbx/` in a project folder, used with no server.
 *
 * What matters most here is what must never happen. A restore or a switch
 * must not overwrite an unsaved edit it did not ask about, must not touch a
 * file the history has never held, and must not write a byte outside the
 * folder whatever a stored tree says. Everything else is bookkeeping.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  diff,
  init,
  log,
  pathFilter,
  Repository,
  restore,
  save,
  status,
  switchLine,
  UnsavedChanges,
} from "../dist/local/history.js";
import { lineNameProblem } from "../dist/local/repository.js";

async function project(files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-local-"));
  for (const [name, contents] of Object.entries(files)) await put(root, name, contents);
  return root;
}

async function put(root: string, name: string, contents: string | Buffer): Promise<void> {
  const full = path.join(root, name);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  /* Old enough that the index trusts it; see RACY_WINDOW_MS. */
  const past = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 10_000));
  await utimes(full, past, past);
}

const read = (root: string, name: string) => readFile(path.join(root, name), "utf8");

async function gone(root: string, name: string): Promise<boolean> {
  try {
    await stat(path.join(root, name));
    return false;
  } catch {
    return true;
  }
}

test("init makes a history and refuses to make a second one", async () => {
  const root = await project({ "a.txt": "one\n" });
  try {
    const repository = await init(root);
    assert.equal(await repository.currentLine(), "main");
    assert.equal(await repository.head(), null);
    await assert.rejects(init(root), /already has a history/);
    /* Found from anywhere inside. */
    await mkdir(path.join(root, "deep", "er"), { recursive: true });
    const found = await Repository.find(path.join(root, "deep", "er"));
    assert.equal(found?.root, path.resolve(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("save records the folder, and refuses a save that changes nothing", async () => {
  const root = await project({ "a.txt": "one\n", "src/b.ts": "export {};\n" });
  try {
    const repository = await init(root);
    const first = await save(repository, { message: "start", author: "tester" });
    assert.equal(first.saved, true);
    if (!first.saved) return;
    assert.deepEqual(first.changes.added, ["a.txt", "src/b.ts"]);
    assert.equal(first.save.parents.length, 0);
    assert.equal(await repository.head(), first.save.id);

    const again = await save(repository, { message: "nothing", author: "tester" });
    assert.deepEqual(again, { saved: false, reason: "unchanged" });

    await put(root, "a.txt", "two\n");
    const second = await save(repository, { message: "edit", author: "tester" });
    assert.equal(second.saved, true);
    if (!second.saved) return;
    assert.deepEqual(second.changes.modified, ["a.txt"]);
    assert.deepEqual(second.save.parents, [first.save.id]);

    const history = await log(repository);
    assert.deepEqual(history.map((one) => one.message), ["edit", "start"]);
    assert.equal((await log(repository, { limit: 1 })).length, 1);
    await assert.rejects(save(repository, { message: "  " }), /needs a message/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the store never saves itself, and the ignore rules decide what counts", async () => {
  const root = await project({
    ".gitignore": "build/\n",
    "keep.txt": "kept\n",
    "build/out.bin": "made by a build\n",
  });
  try {
    const repository = await init(root);
    const made = await save(repository, { message: "start", author: "tester" });
    assert.ok(made.saved);
    if (!made.saved) return;
    const tree = await repository.readTree(made.save.tree);
    assert.deepEqual(tree.files.map((file) => file.path), [".gitignore", "keep.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status names what changed since the last save", async () => {
  const root = await project({ "a.txt": "one\n", "b.txt": "two\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "start", author: "tester" });
    await put(root, "a.txt", "changed\n");
    await rm(path.join(root, "b.txt"));
    await put(root, "c.txt", "new\n");
    const now = await status(repository);
    assert.equal(now.line, "main");
    assert.deepEqual(now.changes, { added: ["c.txt"], modified: ["a.txt"], deleted: ["b.txt"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status notices an edit that kept the same size and time", async () => {
  const root = await project({ "a.txt": "aaaa\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "start", author: "tester" });
    const before = await stat(path.join(root, "a.txt"));
    await writeFile(path.join(root, "a.txt"), "bbbb\n");
    /* Same size; put the old time back, as a careless tool might. */
    await utimes(path.join(root, "a.txt"), before.atime, before.mtime);
    /*
      This is the trade the index makes, as git's does: a file whose size and
      time are unchanged is not read. Recorded here so the choice is visible.
    */
    assert.deepEqual((await status(repository)).changes.modified, []);
    await put(root, "a.txt", "bbbbb\n");
    assert.deepEqual((await status(repository)).changes.modified, ["a.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diff shows line changes, and describes binary files instead", async () => {
  const root = await project({
    "notes.md": "alpha\nbeta\ngamma\n",
    "image.bin": Buffer.from([0, 1, 2, 3]),
  });
  try {
    const repository = await init(root);
    await save(repository, { message: "start", author: "tester" });
    await put(root, "notes.md", "alpha\nBETA\ngamma\n");
    await put(root, "image.bin", Buffer.from([0, 9, 9, 9, 9]));
    const changes = await diff(repository);
    assert.deepEqual(changes.map((one) => one.path), ["image.bin", "notes.md"]);
    assert.match(changes[0]!.summary ?? "", /binary/);
    const lines = changes[1]!.chunks!.flatMap((chunk) => ("lines" in chunk ? chunk.lines : []));
    assert.ok(lines.some((line) => line.side === "target" && line.text === "beta"));
    assert.ok(lines.some((line) => line.side === "candidate" && line.text === "BETA"));

    /* Between two saves, and limited to named paths. */
    await save(repository, { message: "second", author: "tester" });
    const between = await diff(repository, {
      from: "main~1",
      to: "main",
      only: pathFilter(repository, ["notes.md"], root),
    });
    assert.deepEqual(between.map((one) => one.path), ["notes.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore puts a save back, and leaves files the history never held alone", async () => {
  const root = await project({ "a.txt": "first\n", "dir/b.txt": "b\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "one", author: "tester" });
    await put(root, "a.txt", "second\n");
    await rm(path.join(root, "dir"), { recursive: true });
    await put(root, "c.txt", "added later\n");
    await save(repository, { message: "two", author: "tester" });
    await put(root, "untracked.log", "not mine\n");
    await writeFile(path.join(root, ".gitignore"), "*.log\n");
    await save(repository, { message: "three", author: "tester" });

    const result = await restore(repository, { from: "main~2" });
    assert.equal(await read(root, "a.txt"), "first\n");
    assert.equal(await read(root, "dir/b.txt"), "b\n");
    assert.ok(await gone(root, "c.txt"));
    assert.equal(await read(root, "untracked.log"), "not mine\n");
    assert.ok(result.removed.includes("c.txt"));
    /* The line did not move; the folder did. */
    assert.equal((await log(repository))[0]!.message, "three");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore refuses to overwrite an unsaved edit unless forced", async () => {
  const root = await project({ "a.txt": "saved\n", "b.txt": "b\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "one", author: "tester" });
    await put(root, "a.txt", "unsaved work\n");

    await assert.rejects(restore(repository), (error: unknown) => {
      assert.ok(error instanceof UnsavedChanges);
      assert.deepEqual(error.files, ["a.txt"]);
      return true;
    });
    assert.equal(await read(root, "a.txt"), "unsaved work\n");

    /* A deleted file is not in the way: bringing it back loses nothing. */
    await rm(path.join(root, "b.txt"));
    await restore(repository, { only: pathFilter(repository, ["b.txt"], root) });
    assert.equal(await read(root, "b.txt"), "b\n");
    assert.equal(await read(root, "a.txt"), "unsaved work\n");

    await restore(repository, { force: true });
    assert.equal(await read(root, "a.txt"), "saved\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore will not write over a file the rules hide but a save holds", async () => {
  const root = await project({ "config.local": "from the save\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "one", author: "tester" });
    await put(root, ".gitignore", "*.local\n");
    await put(root, "config.local", "my machine's settings\n");
    await save(repository, { message: "ignore it", author: "tester" });
    await assert.rejects(restore(repository, { from: "main~1" }), UnsavedChanges);
    assert.equal(await read(root, "config.local"), "my machine's settings\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switch -c starts a line; switching back rewrites only what differs", async () => {
  const root = await project({ "shared.txt": "same\n", "a.txt": "main\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "start", author: "tester" });
    const made = await switchLine(repository, "feature", { create: true });
    assert.equal(made.created, true);
    assert.deepEqual(made.written, []);
    await put(root, "a.txt", "feature\n");
    await put(root, "only-feature.txt", "x\n");
    await save(repository, { message: "on feature", author: "tester" });

    /* An edit to a file both lines hold alike comes along. */
    await put(root, "shared.txt", "edited, unsaved\n");
    const back = await switchLine(repository, "main");
    assert.deepEqual(back.written.sort(), ["a.txt"]);
    assert.deepEqual(back.removed, ["only-feature.txt"]);
    assert.equal(await read(root, "a.txt"), "main\n");
    assert.equal(await read(root, "shared.txt"), "edited, unsaved\n");
    assert.equal(await repository.currentLine(), "main");

    /* An edit to a file the lines disagree about stops it. */
    await put(root, "a.txt", "unsaved on main\n");
    await assert.rejects(switchLine(repository, "feature"), UnsavedChanges);
    assert.equal(await repository.currentLine(), "main");

    await assert.rejects(switchLine(repository, "feature", { create: true }), /already a line/);
    await assert.rejects(switchLine(repository, "nowhere"), /No line called/);
    await assert.rejects(switchLine(repository, "../escape", { create: true }), /Cannot name/);
    assert.deepEqual((await repository.lines()).map((one) => one.name), ["feature", "main"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a large file is split, and an edit in it stores only the pieces around it", async () => {
  const root = await project();
  try {
    /* Random bytes, so compression cannot hide how much was stored. */
    const big = randomBytes(24 * 1024 * 1024);
    await put(root, "asset.bin", big);
    const repository = await init(root);
    const first = await save(repository, { message: "asset", author: "tester" });
    assert.ok(first.saved);
    if (!first.saved) return;
    const firstTree = await repository.readTree(first.save.tree);
    const pieces = firstTree.files[0]!.chunks;
    assert.ok(pieces.length > 1, `expected several pieces, got ${pieces.length}`);

    const edited = Buffer.from(big);
    edited.write("an edit in the middle", 12 * 1024 * 1024);
    await put(root, "asset.bin", edited);
    const second = await save(repository, { message: "edit", author: "tester" });
    assert.ok(second.saved);
    if (!second.saved) return;
    const secondPieces = (await repository.readTree(second.save.tree)).files[0]!.chunks;
    const reused = secondPieces.filter((piece) => pieces.includes(piece)).length;
    assert.ok(reused >= secondPieces.length - 2, `reused ${reused} of ${secondPieces.length}`);

    await restore(repository, { from: "main~1", force: true });
    assert.ok((await readFile(path.join(root, "asset.bin"))).equals(big));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("small files are packed, not written one object per file", async () => {
  const files: Record<string, string> = {};
  for (let at = 0; at < 500; at += 1) files[`src/f${at}.ts`] = `export const v = ${at};\n`;
  const root = await project(files);
  try {
    const first = await init(root);
    const made = await save(first, { message: "many", author: "tester" });
    assert.ok(made.saved);
    const objects = path.join(root, ".cbx", "objects");
    const packs = (await readdir(path.join(objects, "packs"))).filter((name) => name.endsWith(".pack"));
    assert.equal(packs.length, 1);
    /* Only the tree and the save are on their own. */
    const loose = (await readdir(objects)).filter((name) => name !== "packs");
    let count = 0;
    for (const folder of loose) count += (await readdir(path.join(objects, folder))).length;
    assert.equal(count, 2);

    /* A fresh reader finds everything through the pack's index. */
    const again = (await Repository.find(root))!;
    await rm(path.join(root, "src"), { recursive: true });
    await restore(again);
    assert.equal(await read(root, "src/f499.ts"), "export const v = 499;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pack with no index is an unfinished write, and is never read", async () => {
  const root = await project({ "a.txt": "a\n" });
  try {
    const repository = await init(root);
    await save(repository, { message: "one", author: "tester" });
    const packs = path.join(root, ".cbx", "objects", "packs");
    await writeFile(path.join(packs, `${"f".repeat(64)}.pack`), "half a pack");
    const fresh = (await Repository.find(root))!;
    assert.deepEqual((await status(fresh)).changes, { added: [], modified: [], deleted: [] });
    await rm(path.join(root, "a.txt"));
    await restore(fresh);
    assert.equal(await read(root, "a.txt"), "a\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a damaged object is caught when it is read, not written into the folder", async () => {
  const root = await project({ "a.txt": "precious\n" });
  try {
    const repository = await init(root);
    const made = await save(repository, { message: "one", author: "tester" });
    assert.ok(made.saved);
    if (!made.saved) return;
    /* A small file lives in a pack; damage the pack. */
    const packs = path.join(root, ".cbx", "objects", "packs");
    const pack = (await readdir(packs)).find((name) => name.endsWith(".pack"))!;
    const frame = await readFile(path.join(packs, pack));
    frame[frame.length - 1] ^= 0xff;
    await writeFile(path.join(packs, pack), frame);
    await rm(path.join(root, "a.txt"));
    await assert.rejects(restore(repository), /damaged/);
    assert.ok(await gone(root, "a.txt"));
    /* Nothing half-written was left behind either. */
    assert.deepEqual(await readdir(root), [".cbx"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tree naming a path outside the folder is refused before anything is written", async () => {
  const root = await project({ "a.txt": "a\n" });
  const outside = path.join(path.dirname(root), `cbx-escape-${path.basename(root)}.txt`);
  try {
    const repository = await init(root);
    const blob = await repository.objects.put(Buffer.from("escaped\n"));
    for (const hostile of ["../" + path.basename(outside), ".git/config", ".cbx/lines/main"]) {
      const tree = await repository.writeTree([
        { path: hostile, size: 8, sha256: blob, executable: false, chunks: [blob] },
      ]);
      const record = await repository.writeSave({
        format: "cbx-save",
        version: 1,
        tree,
        parents: [],
        line: "main",
        message: "hostile",
        author: "someone",
        created: new Date().toISOString(),
      });
      await assert.rejects(restore(repository, { from: record.id, force: true }), /unsafe path/);
    }
    assert.ok(await gone(path.dirname(outside), path.basename(outside)));
    assert.ok(await gone(root, ".git"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("save ids depend on content, not on the machine", async () => {
  const one = await project({ "a.txt": "a\n", "b/c.txt": "c\n" });
  const two = await project({ "b/c.txt": "c\n", "a.txt": "a\n" });
  try {
    const now = new Date("2026-09-27T00:00:00Z");
    const left = await save(await init(one), { message: "m", author: "x", now });
    const right = await save(await init(two), { message: "m", author: "x", now });
    assert.ok(left.saved && right.saved);
    if (!left.saved || !right.saved) return;
    assert.equal(left.save.id, right.save.id);
  } finally {
    await rm(one, { recursive: true, force: true });
    await rm(two, { recursive: true, force: true });
  }
});

test("saves can be named by a prefix of their id", async () => {
  const root = await project({ "a.txt": "a\n" });
  try {
    const repository = await init(root);
    const made = await save(repository, { message: "one", author: "tester" });
    assert.ok(made.saved);
    if (!made.saved) return;
    assert.equal((await repository.resolve(made.save.id.slice(0, 8))).id, made.save.id);
    await assert.rejects(repository.resolve("zzzz"), /No line or save/);
    await assert.rejects(repository.resolve("main~5"), /further than the line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second writer is turned away while the lock is held", async () => {
  const root = await project({ "a.txt": "a\n" });
  try {
    const repository = await init(root);
    await writeFile(path.join(root, ".cbx", "lock"), "1\n");
    await assert.rejects(save(repository, { message: "m" }), /Another cbx command/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("line names are held to what is safe as a file name everywhere", () => {
  for (const good of ["main", "feature-1", "v2.0", "release_candidate"]) {
    assert.equal(lineNameProblem(good), null, good);
  }
  for (const bad of ["", ".hidden", "a/b", "a\\b", "..", "con", "x.partial", "trail.", "a b"]) {
    assert.notEqual(lineNameProblem(bad), null, bad);
  }
});
