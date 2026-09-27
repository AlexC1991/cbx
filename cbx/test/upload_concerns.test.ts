/**
 * The question the desktop asks before it sends anything.
 *
 * This is the code path a real leak took. A project went up from the desktop
 * carrying a browser profile for a site its owner was signed in to, a cloud
 * CLI's cached login, an emulated database and an unrelated work tree — 98%
 * of its files were not the project — because nothing on that path asked.
 *
 * The check now lives in `uploadConcerns` rather than inside the window's
 * message handler, so it can be proved without starting a window. That is the
 * point of these tests: the desktop is the path that failed, and a rule that
 * can only be exercised by clicking is a rule nobody can show is working.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { uploadConcerns } from "../dist/core/worktree.js";

/** A folder shaped like the one that leaked. */
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-concerns-"));
  const file = async (relative: string) => {
    const full = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "x");
  };
  await file("src/app.py");
  await file("README.md");
  await file("Local Storage/leveldb/000005.ldb");
  await file("Local Storage/leveldb/LOG");
  await file("infra/.wrangler/state/v3/d1/db.sqlite");
  await file(".npmrc");
  return root;
}

test("stops the upload that actually happened", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));

  /*
    The selection the old .gitignore produced: a file list with no patterns,
    so the profile and the service state were both ticked to send.
  */
  const { secrets, shielded } = await uploadConcerns(root, [
    "src/app.py",
    "README.md",
    "Local Storage/leveldb/000005.ldb",
    "infra/.wrangler/state/v3/d1/db.sqlite",
    ".npmrc",
  ]);

  assert.deepEqual(secrets, [".npmrc"], "the credential nobody typed out");
  const named = shielded.map((finding) => finding.path).sort();
  assert.deepEqual(named, ["Local Storage", "infra/.wrangler"]);
  assert.equal(
    shielded.find((f) => f.path === "Local Storage")?.rule,
    "Local Storage/",
    "answers with a rule, which stays true after the browser runs again",
  );
});

test("says nothing about a folder the rules already leave behind", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));

  /*
    The same project, with the profile and the service state excluded. Raising
    them here would be a warning about something nobody is publishing, and the
    reliable way to make people dismiss the one that matters.
  */
  const { secrets, shielded } = await uploadConcerns(root, [
    "src/app.py",
    "README.md",
  ]);

  assert.deepEqual(secrets, []);
  assert.deepEqual(shielded, []);
});

test("a clean project is not questioned", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "main.ts"), "export {};");

  const { secrets, shielded } = await uploadConcerns(root, ["src/main.ts"]);
  assert.equal(secrets.length + shielded.length, 0);
});

test("one file inside a private folder is enough to raise it", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { shielded } = await uploadConcerns(root, [
    "Local Storage/leveldb/LOG",
  ]);
  assert.deepEqual(
    shielded.map((finding) => finding.path),
    ["Local Storage"],
    "the folder is named, not the one file that was ticked",
  );
});
