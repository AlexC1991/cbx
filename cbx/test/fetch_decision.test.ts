import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { changedFiles, STARTER_IGNORE } from "../dist/core/worktree.js";

/**
 * What the desktop decides before it writes a version into a folder.
 *
 * The window has no test harness, so the decision is exercised here as the
 * main process computes it: which files a fetch would write over, given what
 * was placed in the folder and what is arriving. Everything downstream of
 * that answer is a dialog; the answer itself is what decides whether somebody
 * loses work.
 *
 * The rule has three cases and only one of them stops a fetch. Getting that
 * wrong in either direction is bad: too eager and people learn to click past
 * the warning, too lax and the warning never appears when it matters.
 */
const rules = { shared: STARTER_IGNORE, local: "" };
const fixture = async () => mkdtemp(path.join(tmpdir(), "coderook-fetch-"));

const digestOf = async (file: string) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

/** The decision the download handler makes, in the same shape. */
async function atRisk(
  folder: string,
  held: Record<string, string>,
  incoming: Map<string, string>,
): Promise<string[]> {
  const edited = await changedFiles(folder, rules, new Map(Object.entries(held)));
  return edited
    .filter(
      (file) =>
        !file.deleted &&
        incoming.has(file.path) &&
        incoming.get(file.path) !== held[file.path],
    )
    .map((file) => file.path);
}

test("a folder that matches what was placed in it is never at risk", async () => {
  const folder = await fixture();
  await writeFile(path.join(folder, "app.txt"), "one\n");
  const held = { "app.txt": await digestOf(path.join(folder, "app.txt")) };
  // The version moved on. Nothing here is edited, so nothing is in danger.
  const incoming = new Map([["app.txt", "somebody-elses-digest"]]);
  assert.deepEqual(await atRisk(folder, held, incoming), []);
});

test("an unsaved edit the version also changes stops the fetch", async () => {
  const folder = await fixture();
  await writeFile(path.join(folder, "app.txt"), "one\n");
  const placed = await digestOf(path.join(folder, "app.txt"));
  await writeFile(path.join(folder, "app.txt"), "work I have not saved\n");

  const incoming = new Map([["app.txt", "their-new-digest"]]);
  assert.deepEqual(await atRisk(folder, { "app.txt": placed }, incoming), [
    "app.txt",
  ]);
});

test("an edit the version leaves alone does not stop the fetch", async () => {
  const folder = await fixture();
  await writeFile(path.join(folder, "quiet.txt"), "one\n");
  const placed = await digestOf(path.join(folder, "quiet.txt"));
  await writeFile(path.join(folder, "quiet.txt"), "edited but unrelated\n");

  /*
    The incoming version holds this file unchanged, so bringing the folder up
    to date has nothing to say about it. Stopping here would make the warning
    appear for edits that are in no danger, which is how people learn to
    dismiss it without reading.
  */
  const incoming = new Map([["quiet.txt", placed]]);
  assert.deepEqual(await atRisk(folder, { "quiet.txt": placed }, incoming), []);
});

test("a file the version no longer holds is not written over", async () => {
  const folder = await fixture();
  await writeFile(path.join(folder, "dropped.txt"), "one\n");
  const placed = await digestOf(path.join(folder, "dropped.txt"));
  await writeFile(path.join(folder, "dropped.txt"), "still working on it\n");

  // Not in the incoming version at all, so a fetch writes nothing here.
  assert.deepEqual(
    await atRisk(folder, { "dropped.txt": placed }, new Map()),
    [],
  );
});

test("a file made here that the version also holds is at risk", async () => {
  const folder = await fixture();
  await writeFile(path.join(folder, "notes.md"), "my own notes\n");
  /*
    Nothing was ever placed here under that name, so this file is entirely
    somebody's own work — and a colleague has since added a file at the same
    path. Fetching would replace theirs over ours without a word, which is
    the worst version of this: not an edit lost, a whole file.
  */
  const incoming = new Map([["notes.md", "their-digest"]]);
  assert.deepEqual(await atRisk(folder, {}, incoming), ["notes.md"]);
});

test("a file made here that the version does not have is left alone", async () => {
  const folder = await fixture();
  await writeFile(path.join(folder, "scratch.md"), "not finished\n");
  // Nobody else has this path, so a fetch writes nothing over it.
  assert.deepEqual(await atRisk(folder, {}, new Map()), []);
});

test("every genuinely endangered file is named, not merely the first", async () => {
  const folder = await fixture();
  await mkdir(path.join(folder, "src"), { recursive: true });
  const placed: Record<string, string> = {};
  for (const name of ["a.txt", "src/b.txt", "src/c.txt"]) {
    await writeFile(path.join(folder, name), "one\n");
    placed[name] = await digestOf(path.join(folder, name));
  }
  // Two edited, one untouched; the version changes all three.
  await writeFile(path.join(folder, "a.txt"), "edited\n");
  await writeFile(path.join(folder, "src", "c.txt"), "edited\n");

  const incoming = new Map(
    Object.keys(placed).map((name) => [name, "their-digest"] as const),
  );
  assert.deepEqual((await atRisk(folder, placed, incoming)).sort(), [
    "a.txt",
    "src/c.txt",
  ]);
});

test("ignored files are never counted, however they differ", async () => {
  const folder = await fixture();
  await mkdir(path.join(folder, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(folder, "node_modules", "dep", "index.js"), "x\n");
  await writeFile(path.join(folder, ".env"), "TOKEN=local\n");
  await writeFile(path.join(folder, "app.txt"), "one\n");
  const placed = { "app.txt": await digestOf(path.join(folder, "app.txt")) };

  // Nothing the version holds is edited, and the ignored files are not the
  // fetch's business either way.
  const incoming = new Map([["app.txt", placed["app.txt"]!]]);
  assert.deepEqual(await atRisk(folder, placed, incoming), []);
});
