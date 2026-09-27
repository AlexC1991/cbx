/**
 * End-to-end suite for the CodeRook command line, against the live service.
 *
 * Every command the tool offers, driven the way a person drives it, with the
 * account as the judge of what actually happened. Nothing here stubs the
 * network: the point is to catch what unit tests cannot.
 *
 *   node cli-suite.mjs
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { assertSafeTarget, autoClean, scratchRoot } from "./live.mjs";

// Said out loud before anything is created, and cleaned up however this ends.
assertSafeTarget();
const run = promisify(execFile);
const ROOT = path.resolve(scratchRoot("suite"));
/*
  The built entry, run directly. Going through a shell concatenates arguments
  rather than escaping them — which Node now warns about, and which would
  quietly mangle any test whose message or path contained a space or a quote.
  It also means the suite no longer needs the package linked globally.
*/
const ENTRY = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");
const CONFIG = path.join(process.env.APPDATA, "CodeRook");
const API = "https://api.coderook.com";
const token = readFileSync(path.join(CONFIG, "token"), "utf8").trim();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const results = [];
let group = "";

const heading = (name) => {
  group = name;
  console.log(`\n${name}`);
};

function record(name, ok, detail = "") {
  results.push({ group, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail.replace(/\n/g, "\n        ")}`}`);
}

/** Run the CLI. Never throws: a non-zero exit is a result, not a crash. */
async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return {
      code: error.code ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

const check = async (name, args, predicate) => {
  const result = await cli(...args);
  let ok = false;
  let why = "";
  try {
    ok = predicate(result);
  } catch (error) {
    why = String(error);
  }
  record(name, ok, ok ? "" : `exit=${result.code}\n${result.out.trim().slice(0, 300)}${why}`);
  return result;
};

const has = (result, ...needles) =>
  needles.every((needle) => result.out.includes(needle));

const api = async (route, method = "GET", body) => {
  const response = await fetch(`${API}${route}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const write = (file, contents) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
};

// ── setup ───────────────────────────────────────────────────────────────────

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const stamp = Date.now().toString(36);
const project = `suite-${stamp}`;
// Only this run's own projects, so a sweep can never reach anybody else's.
const sweep = autoClean((slug) => slug === project, ROOT);
const work = path.join(ROOT, project);

heading("Identity and service");
await check("doctor reports a healthy service", ["doctor"], (r) =>
  has(r, "Service: ok") && has(r, "Account:"),
);
await check("whoami names the account", ["whoami"], (r) => r.code === 0 && r.out.includes("@"));
await check("--version prints a version", ["--version"], (r) => /^\d+\.\d+\.\d+/.test(r.out.trim()));
await check("--help lists every command group", ["--help"], (r) =>
  has(r, "Getting started", "Working with a folder", "When somebody saved first", "Bundles"),
);
await check("an unknown command fails clearly", ["nonsense"], (r) =>
  r.code !== 0 && has(r, "Unknown command"),
);

heading("Projects");
await check("projects lists the account", ["projects"], (r) => r.code === 0 && r.out.trim().length > 0);

heading("Rules");
write(path.join(work, "src", "main.ts"), 'export const value = 1;\n');
write(path.join(work, "README.md"), "# Suite\n\nA project made by the test suite.\n");
write(path.join(work, "node_modules", "junk", "index.js"), "junk\n");
await check("rules --init writes a starter ignore file", ["rules", work, "--init"], (r) =>
  r.code === 0 && existsSync(path.join(work, ".gitignore")),
);
await check("rules shows what is ignored", ["rules", work], (r) => has(r, "node_modules"));

heading("Status and submit");
await check("status on an unsaved folder lists everything", ["status", work], (r) =>
  has(r, "Not on your account yet") && has(r, "src/main.ts") && !has(r, "node_modules"),
);
await check("dry run sends nothing", ["submit", work, "-m", "dry", "--dry-run"], (r) =>
  r.code === 0 && has(r, "would be sent"),
);
const created = await api(`/v1/repositories`);
record(
  "dry run really created nothing",
  !created.body.repositories.some((repository) => repository.slug === project),
);

write(path.join(work, ".env"), "SECRET=do-not-upload\n");
await check("a credential blocks the upload", ["submit", work, "-m", "secrets"], (r) =>
  r.code !== 0 && has(r, "looks like a credential", ".env"),
);
await check("--allow-secrets is honoured", ["submit", work, "-m", "secrets", "--allow-secrets", "--dry-run"], (r) =>
  r.code === 0 && has(r, ".env"),
);
rmSync(path.join(work, ".env"));

const first = await check("submit creates the project", ["submit", work, "-m", "First"], (r) =>
  r.code === 0 && has(r, "Saved v1"),
);
await check("status is clean straight after", ["status", work], (r) =>
  has(r, "Nothing to submit"),
);

write(path.join(work, "src", "added.ts"), "export const added = true;\n");
await check("a new file is noticed", ["status", work], (r) => has(r, "src/added.ts"));
await check("submit sends only what changed", ["submit", work, "-m", "Second"], (r) =>
  // "unchanged" is what the version keeps without sending; distinct from
  // "already on the account", which is content the service turned out to have.
  r.code === 0 && has(r, "Saved v2") && has(r, "unchanged"),
);

heading("Fetching");
const clone = path.join(ROOT, "clone");
await check("clone fetches into a new folder", ["clone", project, clone], (r) =>
  r.code === 0 && existsSync(path.join(clone, "src", "main.ts")),
);
writeFileSync(path.join(clone, "src", "main.ts"), "locally broken\n");
rmSync(path.join(clone, "README.md"));
/*
  Repairing is what --replace is for: a plain get now keeps local edits, so
  a deliberately broken file would be preserved rather than mended.
*/
await check("get --replace repairs a damaged folder", ["get", clone, "--replace"], (r) =>
  r.code === 0,
);
record(
  "restored content matches the account",
  readFileSync(path.join(clone, "src", "main.ts"), "utf8") === "export const value = 1;\n" &&
    existsSync(path.join(clone, "README.md")),
);
await check("clone refuses an unknown project", ["clone", "no-such-project-xyz", path.join(ROOT, "nope")], (r) =>
  r.code !== 0 && has(r, "No project named"),
);

heading("Bundles");
const bundle = path.join(ROOT, `${project}.cbx`);
await check("bundle packs the project", ["bundle", work, bundle], (r) =>
  r.code === 0 && existsSync(bundle),
);
await check("inspect reports the contents", ["inspect", bundle], (r) => has(r, "files"));
await check("inspect --files lists them", ["inspect", bundle, "--files"], (r) =>
  has(r, "src/main.ts", "README.md"),
);
const unbundled = path.join(ROOT, "unbundled");
await check("unbundle extracts it", ["unbundle", bundle, unbundled], (r) =>
  r.code === 0 && existsSync(path.join(unbundled, "src", "main.ts")),
);
record(
  "unbundled bytes are identical",
  readFileSync(path.join(unbundled, "src", "main.ts"), "utf8") === "export const value = 1;\n",
);

heading("Merging");
await check("merges is empty when nothing waits", ["merges", work], (r) =>
  has(r, "Nothing is waiting"),
);

// A second machine publishes first, editing a different part of the file.
const other = path.join(ROOT, "other");
await cli("clone", project, other);
const bytesEdit = (file, from, to) => {
  const raw = readFileSync(file);
  writeFileSync(file, Buffer.from(raw.toString("utf8").replace(from, to), "utf8"));
};
write(path.join(other, "shared.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
await cli("submit", other, "-m", "Add shared file");
await cli("get", work);
await cli("get", other);
bytesEdit(path.join(other, "shared.txt"), "alpha", "ALPHA");
await cli("submit", other, "-m", "Colleague edits the top");
bytesEdit(path.join(work, "shared.txt"), "epsilon", "EPSILON");
const auto = await check(
  "non-overlapping edits merge without asking",
  ["submit", work, "-m", "I edit the bottom"],
  (r) => r.code === 0 && has(r, "Saved v"),
);
await cli("get", work);
record(
  "both sides' edits survived",
  readFileSync(path.join(work, "shared.txt"), "utf8").includes("ALPHA") &&
    readFileSync(path.join(work, "shared.txt"), "utf8").includes("EPSILON"),
);

// Now the same line from both sides.
await cli("get", other);
bytesEdit(path.join(other, "shared.txt"), "gamma", "GAMMA-THEIRS");
await cli("submit", other, "-m", "Colleague rewrites gamma");
bytesEdit(path.join(work, "shared.txt"), "gamma", "GAMMA-MINE");
const clash = await check(
  "overlapping edits are kept as a merge",
  ["submit", work, "-m", "I rewrite gamma"],
  (r) => r.code === 0 && has(r, "kept as M-", "shared.txt"),
);
const reference = /kept as (M-\d+)/.exec(clash.out)?.[1] ?? "";
record("the merge has a reference", Boolean(reference), clash.out.slice(0, 200));

await check("merges lists it", ["merges", work], (r) => has(r, reference, "to decide"));
await check("merge shows the outstanding decision", ["merge", reference, work], (r) =>
  has(r, "waiting", "shared.txt"),
);
await check("apply is refused before deciding", ["merge", reference, work, "--apply"], (r) =>
  r.code !== 0 && has(r, "Still undecided"),
);
await check("a decision makes it ready", ["merge", reference, work, "--mine"], (r) =>
  has(r, "ready to apply"),
);
await check("apply publishes the result", ["merge", reference, work, "--apply"], (r) =>
  r.code === 0 && has(r, "Applied as v"),
);
await cli("get", work);
record(
  "the chosen side won",
  readFileSync(path.join(work, "shared.txt"), "utf8").includes("GAMMA-MINE"),
);
await check("nothing is left waiting", ["merges", work], (r) => has(r, "Nothing is waiting"));
await check("an unknown merge is refused", ["merge", "M-9999", work], (r) =>
  r.code !== 0 || has(r, "No merge called"),
);

heading("A merge brings down a file this folder never had");
/*
  The colleague adds a whole new file while this folder is behind. The merge
  puts it in the version, but it never reaches this disk — so the next save
  must not read its absence as "delete it". That regression silently threw
  away the colleague's file.
*/
await cli("get", work);
await cli("get", other);
write(path.join(other, "theirs-only.txt"), "only they have this\n");
await cli("submit", other, "-m", "Colleague adds a file of their own");
write(path.join(work, "mine-only.txt"), "only I have this\n");
await check("my save merges their new file in", ["submit", work, "-m", "I add mine"], (r) =>
  r.code === 0 && has(r, "Saved v"),
);
await check("status admits the folder is short of the version", ["status", work], (r) =>
  has(r, "behind the saved version") || has(r, "newer than the cop"),
);
write(path.join(work, "mine-only.txt"), "only I have this, edited\n");
await cli("submit", work, "-m", "I save again without ever fetching");
const stillThere = path.join(ROOT, "still-there");
await cli("clone", project, stillThere);
record(
  "saving again keeps the file this folder never held",
  existsSync(path.join(stillThere, "theirs-only.txt")) &&
    existsSync(path.join(stillThere, "mine-only.txt")),
);

heading("Cancelling a merge");
await cli("get", other);
bytesEdit(path.join(other, "shared.txt"), "beta", "BETA-THEIRS");
await cli("submit", other, "-m", "Colleague edits beta");
bytesEdit(path.join(work, "shared.txt"), "beta", "BETA-MINE");
const second = await cli("submit", work, "-m", "I edit beta");
const cancelRef = /kept as (M-\d+)/.exec(second.out)?.[1] ?? "";
record("a second merge opened", Boolean(cancelRef), second.out.slice(0, 200));
await check("cancel closes it without losing anything", ["merge", cancelRef, work, "--cancel"], (r) =>
  r.code === 0 && has(r, "cancelled"),
);
await check("cancelled merges leave the list", ["merges", work], (r) =>
  has(r, "Nothing is waiting"),
);

heading("A merge changes a file this folder already has");
/*
  The other side edits a file this folder holds. The merge takes their bytes
  into the version, but they never reach this disk. Measured against the
  version the stale copy looks like a local edit — and saving it put the old
  bytes back over theirs, undoing the change without anyone touching it.
*/
/*
  The cancelled merge above left an unresolved local edit in this folder,
  which a plain get now preserves rather than destroys. Starting this
  section level therefore means asking for the version exactly.
*/
await cli("get", work, "--replace");
await cli("get", other, "--replace");
write(path.join(other, "shared.txt"), "THEIRS\n");
await cli("submit", other, "-m", "Colleague rewrites the shared file");
write(path.join(work, "mine-only.txt"), "unrelated\n");
await cli("submit", work, "-m", "I save something unrelated");
record(
  "the folder still holds the older copy",
  readFileSync(path.join(work, "shared.txt"), "utf8").trim() !== "THEIRS",
);
await check("status calls the stale copy behind, not changed", ["status", work], (r) =>
  has(r, "behind the saved version") || has(r, "newer than the cop"),
);
await check("saving again sends nothing rather than reverting them",
  ["submit", work, "-m", "I save again without fetching"],
  (r) => r.code === 0 && has(r, "Nothing to submit"),
);
const notReverted = path.join(ROOT, "not-reverted");
await cli("clone", project, notReverted);
record(
  "their change survived a save from a stale folder",
  readFileSync(path.join(notReverted, "shared.txt"), "utf8").trim() === "THEIRS",
);
await cli("get", work);
record(
  "get brings their bytes down",
  readFileSync(path.join(work, "shared.txt"), "utf8").trim() === "THEIRS",
);
write(path.join(work, "shared.txt"), "MINE-ON-PURPOSE\n");
await cli("submit", work, "-m", "I edit the shared file deliberately");
const deliberate = path.join(ROOT, "deliberate");
await cli("clone", project, deliberate);
record(
  "a deliberate edit is still sent",
  readFileSync(path.join(deliberate, "shared.txt"), "utf8").trim() === "MINE-ON-PURPOSE",
);

heading("Sign out and back in");
await check("sign-out clears the token", ["sign-out"], (r) => r.code === 0);
await check("whoami then fails", ["whoami"], (r) => r.code !== 0 || has(r, "Not signed in"));
await check("sign-in with a token restores it", ["sign-in", "--token", token], (r) => r.code === 0);
await check("whoami works again", ["whoami"], (r) => r.code === 0 && r.out.includes("@"));

// ── cleanup ─────────────────────────────────────────────────────────────────

heading("Cleanup");
const list = await api("/v1/repositories");
const made = list.body.repositories.find((repository) => repository.slug === project);
if (made) {
  const removed = await api(`/v1/repositories/${made.id}`, "DELETE");
  record("the suite's project was removed", removed.status === 204 || removed.status === 200,
    `status ${removed.status}`);
}
await sweep();
rmSync(ROOT, { recursive: true, force: true });

// ── report ──────────────────────────────────────────────────────────────────

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  ${f.group} — ${f.name}`).join("\n")}` : ""),
);
process.exitCode = failed.length ? 1 : 0;
