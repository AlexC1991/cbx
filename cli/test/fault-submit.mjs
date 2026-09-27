/*
  Killing a save between two correct steps.

  Saving is: upload every object, then create the version that names them,
  then record locally that it happened. Each step is fine; stopping between
  two of them is where a save either vanishes or happens twice.

  The two cuts that matter are the ones either side of the commit. Before it,
  nothing on the account may exist. After it, the version is real and this
  machine does not know — which is exactly the state the derived attempt name
  was built to survive, so a retry has to find that version rather than make
  a second one.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { assertSafeTarget, autoClean, scratchRoot, liveToken, apiOrigin } from "./live.mjs";
import { firstLink } from "./links.mjs";

assertSafeTarget();
const root = path.resolve(scratchRoot("suite-faultsubmit"));
mkdirSync(root, { recursive: true });
const token = liveToken();
const API = apiOrigin();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`          ${String(detail).replace(/\n/g, "\n          ")}`);
};

function rook(cwd, home, args, fault) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [entry, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, CODEROOK_CONFIG_DIR: home,
        CODEROOK_TOKEN: token, NO_COLOR: "1",
        ...(fault ? { CODEROOK_FAULT: fault } : {}) } }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const stamp = Date.now().toString(36);
const sweep = autoClean((slug) => slug.startsWith(`fsub${stamp}`), root);

const versionsOf = async (repositoryId) =>
  (await (await fetch(`${API}/v1/repositories/${repositoryId}/versions`, { headers }))
    .json()).versions;

function project(name) {
  const slug = `fsub${stamp}-${name}`;
  const folder = path.join(root, slug);
  const home = path.join(root, `h-${name}-${stamp}`);
  mkdirSync(folder, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(folder, "app.txt"), "one\n");
  const first = rook(folder, home, ["submit", "-m", "v1"]);
  if (!/Saved v1/.test(first.out)) throw new Error(`${name}: setup failed\n${first.out}`);
  return { slug, folder, home, repositoryId: firstLink(home).repositoryId };
}

// ── stopped after the objects, before anything on the account ───────────────

{
  const w = project("objects");
  writeFileSync(path.join(w.folder, "app.txt"), "two\n");
  const cut = rook(w.folder, w.home, ["submit", "-m", "interrupted"], "submit:after-objects");
  record("the save really was interrupted", cut.code !== 0, cut.out.trim().slice(0, 200));

  const after = await versionsOf(w.repositoryId);
  record("no version was created",
    after.length === 1, `${after.length} versions`);

  /*
    The objects are already stored and immutable, so retrying must not need
    them again — and must produce exactly one version.
  */
  const retry = rook(w.folder, w.home, ["submit", "-m", "interrupted"]);
  const recovered = await versionsOf(w.repositoryId);
  record("retrying completes the save", /Saved v2/.test(retry.out), retry.out.trim());
  record("and there is one version, not two",
    recovered.length === 2, `${recovered.length} versions`);
  record("the objects already uploaded were not sent again",
    /already on the account/.test(retry.out), retry.out.trim());
}

// ── stopped after the commit, before this machine recorded it ───────────────

{
  const w = project("commit");
  writeFileSync(path.join(w.folder, "app.txt"), "two\n");
  const cut = rook(w.folder, w.home, ["submit", "-m", "committed then lost"], "submit:after-commit");
  record("the save really was interrupted after committing",
    cut.code !== 0, cut.out.trim().slice(0, 200));

  const committed = await versionsOf(w.repositoryId);
  record("the version does exist on the account",
    committed.length === 2, `${committed.length} versions`);

  const link = firstLink(w.home);
  record("but this machine still thinks it is on the older one",
    link.sequence === 1,
    JSON.stringify(link.sequence));

  // The same command again is what somebody would actually do.
  const retry = rook(w.folder, w.home, ["submit", "-m", "committed then lost"]);
  const after = await versionsOf(w.repositoryId);
  record("retrying makes no second version",
    after.length === 2, `${after.length} versions`);
  record("and it says so rather than pretending it saved again",
    /Already saved/.test(retry.out) || /Nothing to submit/.test(retry.out),
    retry.out.trim());

  const repaired = firstLink(w.home);
  record("the local record catches up",
    repaired.sequence === 2,
    JSON.stringify(repaired.sequence));
}

// ── a changed message after a commit is a different save ────────────────────

{
  const w = project("message");
  writeFileSync(path.join(w.folder, "app.txt"), "two\n");
  rook(w.folder, w.home, ["submit", "-m", "first wording"], "submit:after-commit");
  const committed = await versionsOf(w.repositoryId);

  /*
    Same content, different message. The attempt is genuinely different, so a
    second version is the right answer — but the content is already stored, so
    nothing should be uploaded twice.
  */
  const reworded = rook(w.folder, w.home, ["submit", "-m", "second wording"]);
  const after = await versionsOf(w.repositoryId);
  record("rewording after a lost response makes a new version",
    after.length === committed.length + 1,
    `${committed.length} -> ${after.length}\n${reworded.out.trim()}`);
  record("without sending the content again",
    /already on the account/.test(reworded.out), reworded.out.trim());
}

await sweep();
const failed = results.filter((one) => !one.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`\n${failed.map((one) => `  ${one.name}`).join("\n")}`);
process.exit(failed.length ? 1 : 0);
