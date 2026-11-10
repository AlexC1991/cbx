/**
 * The engine's quiet status (engine/src/quick.rs), which answers "nothing has
 * changed" without Node. It may only ever say what the full status would say,
 * so most of this is the cases where it must decline and leave the answer to
 * the full status.
 *
 * Needs the engine binary; skipped where there is none.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { init, save, status } from "../dist/local/history.js";
import { Repository } from "../dist/local/repository.js";
import { engineQuickStatus } from "../dist/shared/native_engine.js";

const binary = path.resolve(
  "..",
  "cli",
  "engine-bin",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "cbx-engine.exe" : "cbx-engine",
);
const engine = process.env.CBX_ENGINE && process.env.CBX_ENGINE !== "off" ? process.env.CBX_ENGINE : binary;
const available = existsSync(engine);

async function settled(file: string, content: string): Promise<void> {
  await writeFile(file, content);
  /* Older than the index's racy window, so the index keeps it. */
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
}

async function history(format: "1" | "2"): Promise<{ root: string; repository: Repository }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-quick-"));
  const before = process.env.CBX_LOCAL_FORMAT;
  process.env.CBX_LOCAL_FORMAT = format;
  try {
    await init(root);
  } finally {
    if (before === undefined) delete process.env.CBX_LOCAL_FORMAT;
    else process.env.CBX_LOCAL_FORMAT = before;
  }
  await settled(path.join(root, ".gitignore"), "# keep everything\n");
  await mkdir(path.join(root, "src"), { recursive: true });
  await settled(path.join(root, "src", "a.txt"), "alpha\n");
  await settled(path.join(root, "src", "b.txt"), "bravo\n");
  const repository = await Repository.open(root);
  await save(repository, { message: "first save\nwith a second line" });
  await status(repository);
  return { root, repository };
}

test("the engine says clean only for a folder that is exactly its last save", { skip: !available }, async () => {
  process.env.CBX_ENGINE = engine;
  const { root, repository } = await history("2");
  try {
    const head = await repository.head();
    const clean = await engineQuickStatus(root);
    assert.equal(clean?.answer, "clean");
    if (clean?.answer === "clean") {
      assert.equal(clean.head, head);
      assert.equal(clean.line, "main");
      assert.equal(clean.project, path.basename(root));
      assert.equal(clean.message.split("\n")[0], "first save");
    }

    /* Same size, new bytes, a new time: named as changed, as the full status names it. */
    await settled(path.join(root, "src", "a.txt"), "ALPHA\n");
    let answer = await engineQuickStatus(root);
    assert.equal(answer?.answer, "changed");
    if (answer?.answer === "changed") assert.deepEqual(answer.modified, ["src/a.txt"]);
    assert.deepEqual((await status(repository)).changes.modified, ["src/a.txt"]);
    await settled(path.join(root, "src", "a.txt"), "alpha\n");
    await status(repository);
    assert.equal((await engineQuickStatus(root))?.answer, "clean");

    /* A new file, then a missing one. */
    await settled(path.join(root, "src", "c.txt"), "charlie\n");
    answer = await engineQuickStatus(root);
    assert.equal(answer?.answer, "changed");
    if (answer?.answer === "changed") assert.deepEqual([answer.added, answer.deleted], [["src/c.txt"], []]);
    await rm(path.join(root, "src", "c.txt"));
    assert.equal((await engineQuickStatus(root))?.answer, "clean");
    await rm(path.join(root, "src", "b.txt"));
    answer = await engineQuickStatus(root);
    assert.equal(answer?.answer, "changed");
    if (answer?.answer === "changed") assert.deepEqual(answer.deleted, ["src/b.txt"]);
    await settled(path.join(root, "src", "b.txt"), "bravo\n");

    /* The same bytes written again a moment ago: read, found the same. */
    await writeFile(path.join(root, "src", "b.txt"), "bravo\n");
    assert.equal((await engineQuickStatus(root))?.answer, "clean");
    await settled(path.join(root, "src", "b.txt"), "bravo\n");
    await status(repository);

    /* A file the index does not hold yet, written just before a save: not vouched for. */
    await writeFile(path.join(root, "src", "fresh.txt"), "fresh\n");
    await save(repository, { message: "with a fresh file" });
    assert.equal((await engineQuickStatus(root))?.answer, "unknown");
    await settled(path.join(root, "src", "fresh.txt"), "fresh\n");
    await status(repository);
    assert.equal((await engineQuickStatus(root))?.answer, "clean");

    /* A merge waiting, a Git repository, a line moved from under the stamp. */
    await writeFile(path.join(root, ".cbx", "merge.json"), "{}");
    assert.equal((await engineQuickStatus(root))?.answer, "unknown");
    await rm(path.join(root, ".cbx", "merge.json"));
    await mkdir(path.join(root, ".git"));
    assert.equal((await engineQuickStatus(root))?.answer, "unknown");
    await rm(path.join(root, ".git"), { recursive: true });
    assert.equal((await engineQuickStatus(root))?.answer, "clean");
    await repository.setLineTip("main", "0".repeat(64));
    assert.equal((await engineQuickStatus(root))?.answer, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a v1 history is never answered by the engine", { skip: !available }, async () => {
  process.env.CBX_ENGINE = engine;
  const { root } = await history("1");
  try {
    assert.equal((await engineQuickStatus(root))?.answer, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
