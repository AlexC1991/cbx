/**
 * Catching what actually gets published by accident.
 *
 * These cases are taken from a real upload: a project went up carrying a
 * browser profile for a site the owner was signed in to, a Cloudflare CLI's
 * cached login, and an emulated database — 98% of the files in it were not
 * the project at all. The check that existed at the time matched `.env`,
 * three key suffixes and a folder called `secrets`, so it saw none of it.
 *
 * The point of the fixtures below is that they are named the way the real
 * ones are: nobody types `Local Storage/leveldb/000005.ldb`, a program does.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectPrivateDirectories,
  detectSecrets,
} from "../dist/core/worktree.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-private-"));
  const file = async (relative: string, body = "x") => {
    const full = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  };

  // The project itself.
  await file("src/app.py", "print('hello')");
  await file("README.md", "# project");

  // A browser profile, exactly as one arrives.
  await file("Local Storage/leveldb/000005.ldb");
  await file("Local Storage/leveldb/LOCK");
  await file("Session Storage/000003.log");
  await file("IndexedDB/https_example.test_0.indexeddb.leveldb/LOG");

  // A cloud CLI's own state and cached login.
  await file("infra/.wrangler/state/v3/d1/db.sqlite");
  await file("infra/node_modules/.cache/wrangler/wrangler-account.json");

  // Credentials that no one typed out.
  await file(".npmrc", "//registry.npmjs.org/:_authToken=redacted");
  await file("deploy/id_ed25519");
  await file("certs/server.pem");

  return root;
}

test("names a browser profile, not the files inside it", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const found = await detectPrivateDirectories(root);
  const paths = found.map((entry) => entry.path).sort();

  assert.ok(paths.includes("Local Storage"), "browser local storage");
  assert.ok(paths.includes("Session Storage"), "browser session storage");
  assert.ok(paths.includes("IndexedDB"), "browser indexeddb");
  assert.ok(paths.includes("infra/.wrangler"), "emulated service state");

  /*
    The answer is a rule, not a list. A list of the files under a profile is
    stale as soon as the browser runs again, which is why the leak got past a
    filter screen that had written one.
  */
  const rule = found.find((entry) => entry.path === "Local Storage");
  assert.equal(rule?.rule, "Local Storage/");
  assert.ok(rule && rule.because.length > 10, "says why, in words");
});

test("does not walk into what it has already condemned", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const found = await detectPrivateDirectories(root);
  const inside = found.filter((entry) => entry.path.startsWith("Local Storage/"));
  assert.equal(inside.length, 0, "the folder is the answer, not its contents");
});

test("names the dependency folder that hides cached logins", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const found = await detectPrivateDirectories(root);
  const nm = found.find((entry) => entry.path === "infra/node_modules");
  assert.ok(nm, "node_modules is named");
  assert.equal(nm?.rule, "infra/node_modules/");
});

test("leaves the actual project alone", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const found = await detectPrivateDirectories(root);
  assert.ok(
    !found.some((entry) => entry.path === "src" || entry.path === "deploy"),
    "ordinary folders are not condemned",
  );
});

test("finds credentials a tool wrote, not just hand-written .env files", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const secrets = await detectSecrets(root);
  assert.ok(secrets.includes(".npmrc"), "registry token");
  assert.ok(secrets.includes("deploy/id_ed25519"), "ssh key");
  assert.ok(secrets.includes("certs/server.pem"), "certificate");
  /*
    Deliberately NOT expected here. The credential walk refuses to descend
    into node_modules, so a login cached inside one is unreachable by name —
    which is where the real one was. Covering it is the directory check's
    job, asserted below, and pretending otherwise would be a test that passes
    by describing something the code does not do.
  */
  assert.ok(
    !secrets.some((entry) => entry.includes("node_modules")),
    "the name walk does not descend into dependency folders",
  );
  assert.ok(
    !secrets.includes("README.md") && !secrets.includes("src/app.py"),
    "ordinary files are not credentials",
  );
});
