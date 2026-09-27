/*
  Fetching writes over the folder. That is what it is for — but an edit
  somebody made and has not saved exists nowhere else, and overwriting it
  loses work permanently.

  The materialisation record is what makes the three cases separable: disk
  differing from what was placed here is an edit, disk matching it is an old
  copy safe to replace, and a file the incoming version leaves alone is not
  this fetch's business either way.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { assertSafeTarget, autoClean, liveToken, scratchRoot, versionFilePayload } from "./live.mjs";
import { firstLink } from "./links.mjs";

assertSafeTarget();
const root = path.resolve(scratchRoot("suite-getedits"));
mkdirSync(root, { recursive: true });
const token = liveToken();
const API = "https://api.coderook.com";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");

function rook(cwd, home, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [entry, ...args],
      { cwd, encoding: "utf8", env: { ...process.env, CODEROOK_CONFIG_DIR: home,
        CODEROOK_TOKEN: token, NO_COLOR: "1" } }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`          ${String(detail).replace(/\n/g, "\n          ")}`);
};

const stamp = Date.now().toString(36);
const slug = `getedits-${stamp}`;
const sam = path.join(root, slug);
const mira = path.join(root, `ge-mira-${stamp}`);
const homeA = path.join(root, `ge-a-${stamp}`);
const homeM = path.join(root, `ge-m-${stamp}`);
for (const made of [sam, homeA, homeM]) mkdirSync(made, { recursive: true });
const sweep = autoClean((one) => one === slug, root);

writeFileSync(path.join(sam, "shared.txt"), "original\n");
writeFileSync(path.join(sam, "untouched.txt"), "quiet\n");
rook(sam, homeA, ["submit", "-m", "v1"]);
const repositoryId = firstLink(homeA).repositoryId;

// Mira moves the project on.
rook(root, homeM, ["clone", slug, mira]);
writeFileSync(path.join(mira, "shared.txt"), "mira's version\n");
rook(mira, homeM, ["submit", "-m", "mira edits shared"]);

// Sam edits the same file and has not saved it.
writeFileSync(path.join(sam, "shared.txt"), "work I have not saved yet\n");
const refused = rook(root, homeA, ["get", sam]);

record("fetching is refused rather than overwriting unsaved work",
  refused.code !== 0 && /would overwrite/.test(refused.out), refused.out.trim());
record("it names the file at risk", /shared\.txt/.test(refused.out), refused.out.trim());
record("and the unsaved work is still on disk",
  readFileSync(path.join(sam, "shared.txt"), "utf8").trim() === "work I have not saved yet");

/*
  An edit to a file the incoming version does not touch is in no danger:
  bringing the folder up to date has nothing to say about it, so it is kept
  and the fetch goes ahead.
*/
writeFileSync(path.join(sam, "shared.txt"), "original\n");
writeFileSync(path.join(sam, "untouched.txt"), "edited but unrelated\n");
const allowed = rook(root, homeA, ["get", sam]);
record("an edit the incoming version does not touch does not block it",
  allowed.code === 0, allowed.out.trim());
record("that edit is kept exactly as it was",
  readFileSync(path.join(sam, "untouched.txt"), "utf8").trim() === "edited but unrelated");
record("while the change that did arrive was applied",
  readFileSync(path.join(sam, "shared.txt"), "utf8").trim() === "mira's version");

// --replace is the way to say "throw my changes away".
writeFileSync(path.join(mira, "shared.txt"), "mira again\n");
rook(mira, homeM, ["submit", "-m", "mira edits again"]);
writeFileSync(path.join(sam, "shared.txt"), "doomed local edit\n");
const forced = rook(root, homeA, ["get", sam, "--replace"]);
record("--replace discards them deliberately", forced.code === 0, forced.out.trim());
record("and the incoming version won",
  readFileSync(path.join(sam, "shared.txt"), "utf8").trim() === "mira again");
/*
  And --replace means the version, not the folder. The local edit to
  untouched.txt was never saved, so an exact copy of the version restores
  what the version actually holds — which is the original, not the edit.
  That is the whole difference between the two modes.
*/
record("--replace restores what the version holds, not what was here", (() => {
  writeFileSync(path.join(sam, "untouched.txt"), "corrupted somehow\n");
  const repaired = rook(root, homeA, ["get", sam, "--replace"]);
  return repaired.code === 0 &&
    readFileSync(path.join(sam, "untouched.txt"), "utf8").trim() === "quiet";
})());

// A stale copy is not an edit, so it must never block a fetch.
writeFileSync(path.join(mira, "shared.txt"), "mira a third time\n");
rook(mira, homeM, ["submit", "-m", "mira third"]);
writeFileSync(path.join(sam, "other.txt"), "sam adds something\n");
rook(sam, homeA, ["submit", "-m", "sam saves unrelated"]);
// Sam's shared.txt is now stale against the head but is not edited.
const stale = rook(root, homeA, ["get", sam]);
record("a stale copy does not look like an edit", stale.code === 0, stale.out.trim());

/*
  The deletion half of the same matrix. A file the version drops is removed
  from the folder — unless somebody has been working on it, in which case
  somebody else's deletion is not permission to throw that work away.
*/
writeFileSync(path.join(sam, "doomed.txt"), "will be dropped\n");
writeFileSync(path.join(sam, "alsodoomed.txt"), "will also be dropped\n");
rook(sam, homeA, ["submit", "-m", "sam adds two files"]);
rook(root, homeM, ["get", mira]);

const head = (await (await fetch(`${API}/v1/repositories/${repositoryId}/versions`,
  { headers })).json()).versions[0];
const kept = (await (await fetch(
  `${API}/v1/repositories/${repositoryId}/versions/${head.id}/files`, { headers })).json())
  .files.filter((f) => f.path !== "doomed.txt" && f.path !== "alsodoomed.txt")
  .map(versionFilePayload);
await fetch(`${API}/v1/repositories/${repositoryId}/versions`, {
  method: "POST", headers,
  body: JSON.stringify({ message: "mira drops both", expectedHeadVersionId: head.id,
    sourceSize: kept.reduce((s, f) => s + f.sourceSize, 0),
    storedSize: kept.reduce((s, f) => s + f.storedSize, 0), files: kept }),
});

// One of them this folder has been editing; the other it has not touched.
writeFileSync(path.join(sam, "alsodoomed.txt"), "but I am still working on it\n");
const dropping = rook(root, homeA, ["get", sam]);
record("the fetch succeeds", dropping.code === 0, dropping.out.trim());
record("an untouched dropped file is removed",
  !existsSync(path.join(sam, "doomed.txt")));
record("one being worked on is kept, not deleted by somebody else",
  existsSync(path.join(sam, "alsodoomed.txt")) &&
    readFileSync(path.join(sam, "alsodoomed.txt"), "utf8").trim() ===
      "but I am still working on it");

await sweep();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
