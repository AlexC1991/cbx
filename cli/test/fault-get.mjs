/*
  Killing a fetch between two correct steps.

  Bringing a folder up to date is a sequence: download and verify, put each
  file in place, remove what the version dropped, record what was placed. Any
  two of those steps are individually fine; the danger is stopping between
  them, which ordinary testing never does because it runs the sequence to the
  end.

  The rule each cut has to satisfy is not that nothing changed. It is that
  whatever is left behind must be honest: either the old state, or the new
  one, or something a following fetch can finish — never a folder that is
  half updated and reports itself as level.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { apiOrigin, assertSafeTarget, autoClean, liveToken, scratchRoot, versionFilePayload } from "./live.mjs";
import { firstLink } from "./links.mjs";

assertSafeTarget();
const root = path.resolve(scratchRoot("suite-faultget"));
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

const api = async (route, method = "GET", body) => {
  const response = await fetch(`${API}${route}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const stamp = Date.now().toString(36);
const sweep = autoClean((slug) => slug.startsWith(`fault${stamp}`), root);

/**
 * A folder on v1, with the project moved on to v2 behind its back.
 *
 * v2 changes one file, adds another and drops a third, so that every step of
 * the fetch has something to do and a cut between any two of them leaves a
 * distinguishable state.
 */
async function behindFolder(name) {
  const slug = `fault${stamp}-${name}`;
  const folder = path.join(root, slug);
  const home = path.join(root, `h-${name}-${stamp}`);
  const mate = path.join(root, `m-${name}-${stamp}`);
  const mateHome = path.join(root, `mh-${name}-${stamp}`);
  mkdirSync(folder, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(mateHome, { recursive: true });

  writeFileSync(path.join(folder, "changed.txt"), "old\n");
  writeFileSync(path.join(folder, "dropped.txt"), "goes away\n");
  writeFileSync(path.join(folder, "steady.txt"), "unchanged\n");
  rook(folder, home, ["submit", "-m", "v1", "--no-licence"]);
  const repositoryId = firstLink(home).repositoryId;

  rook(root, mateHome, ["clone", slug, mate]);
  writeFileSync(path.join(mate, "changed.txt"), "new\n");
  writeFileSync(path.join(mate, "added.txt"), "brand new\n");
  rook(mate, mateHome, ["submit", "-m", "colleague changes and adds"]);

  // Dropping needs the API: the command line never sends a deletion.
  const head = (await api(`/v1/repositories/${repositoryId}/versions`)).body.versions[0];
  const kept = (await api(`/v1/repositories/${repositoryId}/versions/${head.id}/files`))
    .body.files.filter((file) => file.path !== "dropped.txt")
    .map(versionFilePayload);
  await api(`/v1/repositories/${repositoryId}/versions`, "POST", {
    message: "colleague drops one",
    expectedHeadVersionId: head.id,
    deletions: ["dropped.txt"],
    sourceSize: kept.reduce((sum, one) => sum + one.sourceSize, 0),
    storedSize: kept.reduce((sum, one) => sum + one.storedSize, 0),
    files: kept,
  });

  return { slug, folder, home, repositoryId };
}

const complete = (folder) => {
  const held = readdirSync(folder).sort().join(",");
  const changed = existsSync(path.join(folder, "changed.txt"))
    ? readFileSync(path.join(folder, "changed.txt"), "utf8").trim()
    : null;
  return { held, changed };
};

const OLD = { held: "changed.txt,dropped.txt,steady.txt", changed: "old" };
const NEW = { held: "added.txt,changed.txt,steady.txt", changed: "new" };
const describe = (state) => `${state.held} · changed=${state.changed}`;

const POINTS = [
  "get:after-staging",
  "get:after-first-file",
  "get:after-delete",
  "get:before-record",
  "get:after-record",
];

for (const point of POINTS) {
  const name = point.replace("get:", "");
  const w = await behindFolder(name);

  const cut = rook(root, w.home, ["get", w.folder], point);
  record(`${name} · the fetch really was interrupted`,
    cut.code !== 0 || /Interrupted deliberately/.test(cut.out),
    `exit=${cut.code}\n${cut.out.trim().slice(0, 200)}`);

  const between = complete(w.folder);

  /*
    A following fetch is the recovery. It has to work without anybody being
    told to pass a flag, and it has to end at the new version — an interrupted
    fetch that leaves the folder unable to catch up is the failure this is
    looking for.
  */
  const again = rook(root, w.home, ["get", w.folder]);
  const after = complete(w.folder);

  record(`${name} · a following fetch recovers without a flag`,
    again.code === 0, `exit=${again.code}\n${again.out.trim().slice(0, 300)}`);
  record(`${name} · and lands on the new version`,
    after.held === NEW.held && after.changed === NEW.changed,
    `between: ${describe(between)}\nafter:   ${describe(after)}\nwant:    ${describe(NEW)}`);

  // Nothing may be left half-written where the fetch was staging it.
  record(`${name} · no staging directory is left behind`,
    !existsSync(`${w.folder}.incoming`));
}

/*
  An edit made while the fetch was stopped is the one thing completing it
  must not bury: it exists only on this disk, and the interrupted run has no
  claim on it.
*/
{
  const w = await behindFolder("gap");
  rook(root, w.home, ["get", w.folder], "get:after-first-file");
  writeFileSync(path.join(w.folder, "steady.txt"), "edited while it was stopped\n");
  const resumed = rook(root, w.home, ["get", w.folder]);
  record("an edit made during the interruption stops the resume",
    resumed.code !== 0 && resumed.out.includes("steady.txt"), resumed.out.trim());
  record("and that edit is still on disk",
    readFileSync(path.join(w.folder, "steady.txt"), "utf8").trim() ===
      "edited while it was stopped");
  const forced = rook(root, w.home, ["get", w.folder, "--replace"]);
  record("finishing it deliberately still works",
    forced.code === 0 && complete(w.folder).changed === "new", forced.out.trim());
}

await sweep();
const failed = results.filter((one) => !one.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`\n${failed.map((one) => `  ${one.name}`).join("\n")}`);
process.exit(failed.length ? 1 : 0);
