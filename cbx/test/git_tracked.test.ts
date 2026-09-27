/**
 * Files git tracks go up whatever a rule says, as they do in git.
 *
 * A project's .gitignore said `storage/`, meant for a data folder at the top,
 * and it also matched `internal/storage/` three levels down — where six Go
 * files lived that git had tracked all along. Git kept them; CodeRook dropped
 * them, and the saved project would not build.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateRules,
  gitTracked,
  moveRule,
  readRules,
  surveyFiles,
  TRACKED_BY_GIT,
} from "../dist/core/worktree.js";

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-tracked-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  await mkdir(path.join(root, "src", "internal", "storage"), { recursive: true });
  await mkdir(path.join(root, "storage"), { recursive: true });
  await writeFile(path.join(root, "src", "internal", "storage", "store.go"), "package storage\n");
  await writeFile(path.join(root, "src", "main.go"), "package main\n");
  git("add", ".");
  git("commit", "-q", "-m", "code");
  /* The rule arrives after the code was committed, as in the real project. */
  await writeFile(path.join(root, ".gitignore"), "storage/\n");
  await writeFile(path.join(root, "storage", "cache.db"), "untracked data\n");
  return root;
}

test("a file git tracks goes up even when a rule matches it", async () => {
  const root = await repository();
  try {
    const sent = (await surveyFiles(root, await readRules(root))).map((one) => one.path).sort();
    assert.deepEqual(sent, [".gitignore", "src/internal/storage/store.go", "src/main.go"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the filter screen lists it as kept, and says why", async () => {
  const root = await repository();
  try {
    const evaluation = await evaluateRules(root, await readRules(root));
    const kept = evaluation.excluded.filter((one) => one.forceKept);
    assert.deepEqual(kept.map((one) => [one.path, one.rule]), [
      ["src/internal/storage/store.go", TRACKED_BY_GIT],
    ]);
    const ignored = evaluation.excluded.filter((one) => !one.forceKept).map((one) => one.path);
    assert.deepEqual(ignored, ["storage/cache.db"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignoring a tracked file is refused with what would work", async () => {
  const root = await repository();
  try {
    await assert.rejects(moveRule(root, "src/main.go", false), /git rm --cached/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder that is not a repository is decided by the rules alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-untracked-"));
  try {
    assert.equal(await gitTracked(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
