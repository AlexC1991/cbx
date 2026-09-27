/*
  Upgrading an existing workspace.

  A fresh install proves new users are safe. It says nothing about somebody
  whose folder was connected by a client that predates the materialisation
  record — and that record is what every safety decision now rests on.

  Without it, the only thing on disk is the Version manifest, which says what
  the project held, not what this folder received. Treating one as the other
  is precisely the mistake that caused the original data loss, so the rule
  here is narrow: unknown state may reduce what CodeRook does automatically,
  but it must never license a delete or an overwrite.

  The old client is installed from the registry rather than simulated, so
  what is being migrated is a real record written by a real release.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";
import path from "node:path";

import { assertSafeTarget, autoClean, liveToken, scratchRoot, versionFilePayload } from "./live.mjs";
import { firstLink } from "./links.mjs";

assertSafeTarget();
const root = path.resolve(scratchRoot("suite-upgrade"));
mkdirSync(root, { recursive: true });
const token = liveToken();
const API = "https://api.coderook.com";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const NEW = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");
const OLD_VERSION = "0.3.0";
let OLD = "";

const stamp = Date.now().toString(36);
const sweep = autoClean((slug) => slug.startsWith(`up${stamp}`), root);

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`          ${String(detail).replace(/\n/g, "\n          ")}`);
};

function run(entry, cwd, home, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [entry, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, CODEROOK_CONFIG_DIR: home,
        CODEROOK_TOKEN: token, NO_COLOR: "1" } }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}
const old = (cwd, home, ...args) => run(OLD, cwd, home, args);
const now = (cwd, home, ...args) => run(NEW, cwd, home, args);

const api = async (route, method = "GET", body) => {
  const response = await fetch(`${API}${route}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

/** Change the project from outside this folder, as a colleague would. */
async function publishWithout(repositoryId, drop) {
  const head = (await api(`/v1/repositories/${repositoryId}/versions`)).body.versions[0];
  const files = (await api(`/v1/repositories/${repositoryId}/versions/${head.id}/files`))
    .body.files.filter((file) => !drop.includes(file.path))
    .map(versionFilePayload);
  const made = await api(`/v1/repositories/${repositoryId}/versions`, "POST", {
    message: "a colleague drops a file",
    expectedHeadVersionId: head.id,
    sourceSize: files.reduce((sum, one) => sum + one.sourceSize, 0),
    storedSize: files.reduce((sum, one) => sum + one.storedSize, 0),
    files,
  });
  if (made.status !== 201) throw new Error(`could not drop: ${JSON.stringify(made.body)}`);
}

/* Reads either store: the old client writes links.json, the new one migrates it. */
const linkOf = (home) => firstLink(home);

/**
 * A workspace as an older client left it: connected, with a Version manifest
 * and no record of what was actually placed in the folder.
 */
function legacyWorkspace(name, files) {
  const slug = `up${stamp}-${name}`;
  const folder = path.join(root, slug);
  const home = path.join(root, `cfg-${name}-${stamp}`);
  mkdirSync(folder, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    writeFileSync(path.join(folder, file), body);
  }
  const saved = old(folder, home, "submit", "-m", `made by ${OLD_VERSION}`);
  if (!/Saved v/.test(saved.out)) throw new Error(`${name}: old client failed\n${saved.out}`);
  const link = linkOf(home);
  if (link.local) throw new Error(`${name}: the old client already records materialisation`);
  return { slug, folder, home, repositoryId: link.repositoryId };
}

// ── the old client, from the registry ───────────────────────────────────────

{
  const where = path.join(root, "old-client");
  mkdirSync(where, { recursive: true });
  execFileSync("npm", ["init", "-y"], { cwd: where, shell: true, stdio: "ignore" });
  execFileSync("npm", ["install", `@coderook/cli@${OLD_VERSION}`],
    { cwd: where, shell: true, stdio: "ignore" });
  OLD = path.join(where, "node_modules", "@coderook", "cli", "dist", "cli", "src", "cli.js");
  const version = run(OLD, where, path.join(root, "throwaway"), ["--version"]).out.trim();
  record(`the old client really is ${OLD_VERSION}`, version === OLD_VERSION, version);
}

// ── 1. a clean workspace ────────────────────────────────────────────────────

{
  const w = legacyWorkspace("clean", { "app.txt": "one\n", ".gitignore": "*.log\n" });
  const status = now(w.folder, w.home, "status");
  record("1 · a clean upgraded workspace is readable", status.code === 0, status.out.trim());
  writeFileSync(path.join(w.folder, "app.txt"), "two\n");
  const saved = now(w.folder, w.home, "submit", "-m", "first save after upgrading");
  record("1 · and can still be saved", /Saved v2/.test(saved.out), saved.out.trim());
  record("1 · the upgrade records what the folder holds",
    Boolean(linkOf(w.home).local), JSON.stringify(linkOf(w.home).local ?? null));
}

// ── 2. a file added by somebody else's merge never reached this folder ──────

{
  const w = legacyWorkspace("added", { "app.txt": "one\n" });
  // A colleague adds a file; this folder is not told and does not fetch it.
  const mate = path.join(root, `mate-added-${stamp}`);
  const mateHome = path.join(root, `mh-added-${stamp}`);
  mkdirSync(mateHome, { recursive: true });
  now(root, mateHome, "clone", w.slug, mate);
  writeFileSync(path.join(mate, "theirs.txt"), "their file\n");
  now(mate, mateHome, "submit", "-m", "colleague adds a file");

  writeFileSync(path.join(w.folder, "app.txt"), "two\n");
  const one = now(w.folder, w.home, "submit", "-m", "saving after upgrading", "--force");
  writeFileSync(path.join(w.folder, "app.txt"), "three\n");
  const two = now(w.folder, w.home, "submit", "-m", "and again");
  // Both must actually publish, or the file below survives because nothing
  // happened rather than because the right thing happened.
  record("2 · both saves really published",
    /Saved v/.test(one.out) && /Saved v/.test(two.out),
    `${one.out.trim()}\n---\n${two.out.trim()}`);

  const seen = path.join(root, `see-added-${stamp}`);
  now(root, mateHome, "clone", w.slug, seen);
  record("2 · a file this folder never had survives the upgrade and two saves",
    existsSync(path.join(seen, "theirs.txt")));
}

// ── 3. a stale copy of a file somebody else changed ─────────────────────────

{
  const w = legacyWorkspace("stale", { "shared.txt": "original\n", "mine.txt": "a\n" });
  const mate = path.join(root, `mate-stale-${stamp}`);
  const mateHome = path.join(root, `mh-stale-${stamp}`);
  mkdirSync(mateHome, { recursive: true });
  now(root, mateHome, "clone", w.slug, mate);
  writeFileSync(path.join(mate, "shared.txt"), "theirs\n");
  now(mate, mateHome, "submit", "-m", "colleague rewrites shared");

  // This folder still holds "original" and nobody here has touched it.
  writeFileSync(path.join(w.folder, "mine.txt"), "b\n");
  const saved = now(w.folder, w.home, "submit", "-m", "saving unrelated work", "--force");
  record("3 · the save really published", /Saved v/.test(saved.out), saved.out.trim());
  const seen = path.join(root, `see-stale-${stamp}`);
  now(root, mateHome, "clone", w.slug, seen);
  record("3 · a stale copy does not revert their change across the upgrade",
    readFileSync(path.join(seen, "shared.txt"), "utf8").trim() === "theirs",
    `head holds ${JSON.stringify(readFileSync(path.join(seen, "shared.txt"), "utf8"))}\n${saved.out.trim()}`);
}

// ── 4. a file they deleted is still sitting in this folder ──────────────────

{
  const w = legacyWorkspace("deleted", { "app.txt": "one\n", "doomed.txt": "goes away\n" });
  await publishWithout(w.repositoryId, ["doomed.txt"]);

  writeFileSync(path.join(w.folder, "app.txt"), "two\n");
  const saved = now(w.folder, w.home, "submit", "-m", "saving after their deletion", "--force");
  // Without this the file below is absent because nothing was published,
  // which proves nothing about whether a stale copy would re-add it.
  record("4 · the save really published", /Saved v/.test(saved.out), saved.out.trim());
  const seen = path.join(root, `see-deleted-${stamp}`);
  const seenHome = path.join(root, `sh-deleted-${stamp}`);
  mkdirSync(seenHome, { recursive: true });
  now(root, seenHome, "clone", w.slug, seen);
  record("4 · a stale local copy does not re-add a file they removed",
    !existsSync(path.join(seen, "doomed.txt")));
}

// ── 5. the folder holds things the project never did ────────────────────────

{
  const w = legacyWorkspace("ignored", { "app.txt": "one\n", ".gitignore": "node_modules/\n.env\n" });
  mkdirSync(path.join(w.folder, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(w.folder, "node_modules", "dep", "index.js"), "x\n");
  writeFileSync(path.join(w.folder, ".env"), "TOKEN=local\n");
  mkdirSync(path.join(w.folder, ".git"), { recursive: true });
  writeFileSync(path.join(w.folder, ".git", "HEAD"), "ref: refs/heads/main\n");

  const mate = path.join(root, `mate-ign-${stamp}`);
  const mateHome = path.join(root, `mh-ign-${stamp}`);
  mkdirSync(mateHome, { recursive: true });
  now(root, mateHome, "clone", w.slug, mate);
  writeFileSync(path.join(mate, "app.txt"), "two\n");
  now(mate, mateHome, "submit", "-m", "colleague moves it on");

  const fetched = now(root, w.home, "get", w.folder, "--replace");
  record("5 · fetching into an upgraded workspace keeps what the project never had",
    existsSync(path.join(w.folder, "node_modules", "dep", "index.js")) &&
      existsSync(path.join(w.folder, ".env")) &&
      existsSync(path.join(w.folder, ".git", "HEAD")),
    fetched.out.trim());
}

// ── 6. unsaved edits, with no record of what was placed here ────────────────

{
  const w = legacyWorkspace("edits", { "shared.txt": "original\n" });
  const mate = path.join(root, `mate-edits-${stamp}`);
  const mateHome = path.join(root, `mh-edits-${stamp}`);
  mkdirSync(mateHome, { recursive: true });
  now(root, mateHome, "clone", w.slug, mate);
  writeFileSync(path.join(mate, "shared.txt"), "theirs\n");
  now(mate, mateHome, "submit", "-m", "colleague edits shared");

  writeFileSync(path.join(w.folder, "shared.txt"), "work I have not saved\n");
  const fetched = now(root, w.home, "get", w.folder);
  record("6 · fetching does not silently overwrite unsaved work",
    readFileSync(path.join(w.folder, "shared.txt"), "utf8").trim() === "work I have not saved",
    `exit=${fetched.code}\n${fetched.out.trim()}`);
}

// ── 7. the old record is damaged ────────────────────────────────────────────

{
  const w = legacyWorkspace("broken", { "app.txt": "one\n" });
  const links = path.join(w.home, "links.json");
  const whole = readFileSync(links, "utf8");
  writeFileSync(links, whole.slice(0, Math.floor(whole.length / 2)));

  const status = now(w.folder, w.home, "status");
  const saved = now(w.folder, w.home, "submit", "-m", "saving with a damaged record");
  record("7 · a truncated record fails closed rather than looking unlinked",
    status.code !== 0 || !/Not on your account yet/.test(status.out),
    `status exit=${status.code}\n${status.out.trim()}`);
  record("7 · and does not quietly create a second project",
    !/Saved v1/.test(saved.out),
    `submit exit=${saved.code}\n${saved.out.trim()}`);
}

// ── 8. the folder moved since the old client last saw it ────────────────────

{
  const w = legacyWorkspace("moved", { "app.txt": "one\n" });
  const moved = `${w.folder}-elsewhere`;
  renameSync(w.folder, moved);
  const status = now(moved, w.home, "status");
  record("8 · a moved folder does not claim to hold what it never fetched",
    !/Nothing to submit/.test(status.out) || status.code !== 0,
    `exit=${status.code}\n${status.out.trim()}`);
  rmSync(moved, { recursive: true, force: true });
}

await sweep();
const failed = results.filter((one) => !one.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`\n${failed.map((one) => `  ${one.name}`).join("\n")}`);
process.exit(failed.length ? 1 : 0);
