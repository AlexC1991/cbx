import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  changedFiles,
  detectSecrets,
  readRules,
  STARTER_IGNORE,
} from "../dist/core/worktree.js";

/**
 * The awkward corners of walking a folder.
 *
 * Every case here is one where a scanner can quietly get the wrong answer
 * rather than fail: a rule file written by a different editor, a loop in the
 * directory tree, a file that changed without changing size. A scan that is
 * quietly wrong either uploads something private or omits something needed,
 * and neither announces itself.
 */
const rules = { shared: STARTER_IGNORE, local: "" };
const fixture = async () => mkdtemp(path.join(tmpdir(), "coderook-edge-"));

const digestOf = async (file: string) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

test("ignore rules parse the same however the file was saved", async () => {
  // Three editors, three ways of writing the same two rules.
  for (const [label, body] of [
    ["unix", "node_modules/\n*.log\n"],
    ["windows", "node_modules/\r\n*.log\r\n"],
    ["byte-order mark", "﻿node_modules/\n*.log\n"],
  ] as const) {
    const root = await fixture();
    await writeFile(path.join(root, ".gitignore"), body);
    await writeFile(path.join(root, "app.py"), "print(1)\n");
    await writeFile(path.join(root, "debug.log"), "noise\n");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "x.js"), "x");

    const files = await changedFiles(root, await readRules(root), null);
    const paths = files.map((file) => file.path);
    assert.ok(paths.includes("app.py"), `${label}: the real file is missing`);
    assert.ok(!paths.includes("debug.log"), `${label}: *.log was not applied`);
    assert.ok(
      !paths.some((one) => one.startsWith("node_modules/")),
      `${label}: node_modules/ was not applied`,
    );
  }
});

test("a comment is a comment and an escaped hash is a filename", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".gitignore"), "# *.py\n\\#odd.txt\n");
  await writeFile(path.join(root, "app.py"), "print(1)\n");
  await writeFile(path.join(root, "#odd.txt"), "literal\n");

  const paths = (await changedFiles(root, await readRules(root), null)).map(
    (file) => file.path,
  );
  // The commented rule must not take effect...
  assert.ok(paths.includes("app.py"));
  // ...and the escaped one must.
  assert.ok(!paths.includes("#odd.txt"));
});

test("trailing spaces are not part of a rule unless escaped", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".gitignore"), "notes.txt   \n");
  await writeFile(path.join(root, "notes.txt"), "hello\n");
  const paths = (await changedFiles(root, await readRules(root), null)).map(
    (file) => file.path,
  );
  assert.ok(!paths.includes("notes.txt"), "the rule should still match");
});

test("a symlinked directory loop terminates instead of walking forever", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "inner"), { recursive: true });
  await writeFile(path.join(root, "inner", "real.txt"), "content\n");
  try {
    // A link pointing at its own ancestor: following it is infinite.
    await symlink(root, path.join(root, "inner", "loop"), "junction");
  } catch {
    return; // No permission to create links here; nothing to prove.
  }
  const files = await changedFiles(root, rules, null);
  assert.ok(files.some((file) => file.path === "inner/real.txt"));
  assert.ok(
    !files.some((file) => file.path.includes("loop")),
    "a link must not be walked into",
  );
});

test("a file that changed without changing size or time is still noticed", async () => {
  const root = await fixture();
  const file = path.join(root, "config.json");
  await writeFile(file, '{"mode":"aaa"}\n');
  const when = new Date("2020-01-01T00:00:00Z");
  await utimes(file, when, when);
  const baseline = new Map([["config.json", await digestOf(file)]]);
  assert.deepEqual(await changedFiles(root, rules, baseline), []);

  // Same byte count, same timestamp, different content — the case where
  // anything comparing metadata rather than bytes silently misses the edit.
  await writeFile(file, '{"mode":"bbb"}\n');
  await utimes(file, when, when);
  const after = await changedFiles(root, rules, baseline);
  assert.deepEqual(after.map((one) => one.path), ["config.json"]);
});

test("a folder where every file is ignored offers nothing at all", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".gitignore"), "*\n");
  await writeFile(path.join(root, "app.py"), "print(1)\n");
  await writeFile(path.join(root, "notes.md"), "hello\n");
  const files = await changedFiles(root, await readRules(root), null);
  // Nothing to send is a valid answer. The dangerous reading would be to
  // treat it as "the project is empty now" and publish a version that
  // removes everything.
  assert.deepEqual(files, []);
});

test("secrets are found at any depth, not only at the top", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "a", "b", "c"), { recursive: true });
  await writeFile(path.join(root, ".env"), "TOKEN=1\n");
  await writeFile(path.join(root, "a", ".env.production"), "TOKEN=2\n");
  await writeFile(path.join(root, "a", "b", "server.key"), "key\n");
  await writeFile(path.join(root, "a", "b", "c", "cert.pem"), "cert\n");

  const found = await detectSecrets(root);
  for (const expected of [".env", ".env.production", "server.key", "cert.pem"]) {
    assert.ok(
      found.some((one) => one.endsWith(expected)),
      `${expected} was not reported`,
    );
  }
});

test("an ignored secret is still reported, because ignoring is not deciding", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  await writeFile(path.join(root, ".env"), "TOKEN=1\n");
  const found = await detectSecrets(root);
  // Whether it would be uploaded is a separate question from whether the
  // person should be told it is sitting there.
  assert.ok(found.some((one) => one.endsWith(".env")));
});
