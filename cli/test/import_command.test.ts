import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  fetchSnapshot,
  gitAvailable,
  humanBytes,
  looksLikeRepositoryUrl,
  measure,
  projectNameFromUrl,
} from "../src/import_command.ts";

const run = promisify(execFile);

/**
 * Import is the only command that runs another program against an address
 * somebody typed, so the parts worth testing are the ones where being wrong
 * is quiet: a name derived from a URL, a URL that should have been refused,
 * and whether the fetched tree really is the source repository's content
 * with its history removed.
 *
 * The clone tests build a real git repository in a temporary folder rather
 * than reaching for a network host, so they prove the mechanism without
 * depending on anybody's uptime.
 */

const temporaries: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

async function cleanup(): Promise<void> {
  for (const directory of temporaries.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A real repository with two commits, so "shallow" means something. */
async function repositoryWithTwoCommits(): Promise<string> {
  const source = await scratch("coderook-import-source-");
  const git = (...args: string[]) =>
    run("git", ["-C", source, ...args], { windowsHide: true });

  await run("git", ["init", "-q", "-b", "main", source], { windowsHide: true });
  await git("config", "user.email", "import@example.com");
  await git("config", "user.name", "Import Test");

  await writeFile(path.join(source, "README.md"), "# first\n");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "app.ts"), "export const a = 1;\n");
  await git("add", ".");
  await git("commit", "-qm", "first");

  await writeFile(path.join(source, "README.md"), "# second\n");
  await writeFile(path.join(source, "src", "app.ts"), "export const a = 2;\n");
  await git("add", ".");
  await git("commit", "-qm", "second");
  return source;
}

test("a project name is the repository's, not the host's", () => {
  assert.equal(
    projectNameFromUrl("https://github.com/owner/project.git"),
    "project",
  );
  assert.equal(projectNameFromUrl("https://github.com/owner/project"), "project");
  assert.equal(projectNameFromUrl("git@github.com:owner/project.git"), "project");
  assert.equal(projectNameFromUrl("https://gitlab.com/group/sub/thing/"), "thing");

  /*
    An address with no path is not a repository, and naming somebody's
    project `example.com` because the URL was incomplete is the sort of
    mistake they would only find later.
  */
  assert.equal(projectNameFromUrl(""), "imported-project");
  assert.equal(projectNameFromUrl("   "), "imported-project");
  assert.equal(projectNameFromUrl("https://example.com/"), "imported-project");
});

test("addresses git takes are accepted", () => {
  for (const url of [
    "https://github.com/owner/project.git",
    "http://internal.example/repo",
    "ssh://git@example.com/owner/project.git",
    "git://example.com/project.git",
    "git@github.com:owner/project.git",
  ]) {
    assert.equal(looksLikeRepositoryUrl(url), true, url);
  }
});

test("a local path is refused, because git would otherwise clone it", () => {
  for (const value of [
    "./project",
    "C:\\Users\\someone\\project",
    "/home/someone/project",
    "project",
    "",
    "not a url at all",
  ]) {
    assert.equal(looksLikeRepositoryUrl(value), false, value);
  }
});

test("sizes read the way a person would write them", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(2048), "2.00 KB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5.00 MB");
  assert.equal(humanBytes(20 * 1024 * 1024), "20.0 MB");
});

test("a snapshot has the newest content and none of the history", async (t) => {
  t.after(cleanup);
  assert.equal(await gitAvailable(), true, "git is required for import");

  const source = await repositoryWithTwoCommits();
  const into = path.join(await scratch("coderook-import-into-"), "clone");
  const plan = await fetchSnapshot(source, into);

  assert.equal(plan.folder, path.resolve(into));

  /* Sending .git would upload the history the shallow clone declined. */
  assert.equal(existsSync(path.join(plan.folder, ".git")), false);

  const entries = (await readdir(plan.folder)).sort();
  assert.deepEqual(entries, ["README.md", "src"]);

  const { files, bytes } = await measure(plan.folder);
  assert.equal(files, 2);
  assert.ok(bytes > 0);

  /* The newest commit, not the first. */
  const readme = await readFile(path.join(plan.folder, "README.md"), "utf8");
  assert.equal(readme.trim(), "# second");
});

test("a destination holding files is refused rather than overwritten", async (t) => {
  t.after(cleanup);
  const source = await repositoryWithTwoCommits();
  const occupied = await scratch("coderook-import-occupied-");
  await writeFile(path.join(occupied, "mine.txt"), "do not overwrite me\n");

  await assert.rejects(
    () => fetchSnapshot(source, occupied),
    /already has files/i,
  );

  /* And what was there is still there. */
  assert.ok((await readdir(occupied)).includes("mine.txt"));
});

test("an address that cannot be reached fails rather than half-importing", async (t) => {
  t.after(cleanup);
  const into = path.join(await scratch("coderook-import-bad-"), "clone");
  await assert.rejects(() =>
    fetchSnapshot("https://example.invalid/nothing/here.git", into),
  );
});
