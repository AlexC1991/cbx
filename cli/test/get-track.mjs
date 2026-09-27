/*
  Which line `get` fetches, and whether the folder remembers it afterwards.

  Two failures lived here and both were silent — the fetch reported success
  and the files were wrong, or the files were right and the folder had
  forgotten which line it was on:

    1. `get` took the project's newest version rather than the head of the
       line the folder was switched to. With one line those are the same
       version, which is why it went unnoticed; with two, the newest version
       usually belongs to the line you just left. Switching and fetching
       therefore brought back what you were trying to leave — and `track`
       ends by telling you to run `get`, so the command that set it up was
       the one recommending it.

    2. The record written at the end of a fetch was built fresh rather than
       merged, so `track` was dropped. Every fetch quietly moved the folder
       back to `main`, and the next publish went to a line nobody chose.

    3. `clone` had the same fault one level up: it took the newest version in
       the project rather than the head of its default line. The moment
       anybody pushed to a branch, that branch held the newest version — so
       cloning the project handed you their unfinished work while reporting a
       perfectly ordinary version number. "A clone lands on main" below is
       that regression, and it only fails once a branch is genuinely ahead.

  Both need two lines whose contents actually differ to show up at all, which
  is the whole reason this file exists rather than an assertion bolted onto an
  existing test.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertSafeTarget, autoClean, scratchRoot } from "./live.mjs";

assertSafeTarget();
const root = path.resolve(scratchRoot("suite-track"));
mkdirSync(root, { recursive: true });
const token = readFileSync(
  path.join(process.env.APPDATA, "CodeRook", "token"), "utf8").trim();
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");
const home = path.join(root, "home");
mkdirSync(home, { recursive: true });

/*
  `input` is not optional decoration: `delete` reads the project name from
  stdin to confirm, so a teardown that does not supply it leaves the project
  on the account. This test made four of them before that was noticed.
*/
function cbx(cwd, args, input) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [entry, ...args],
      { cwd, encoding: "utf8", input, env: { ...process.env, CODEROOK_CONFIG_DIR: home,
        CODEROOK_TOKEN: token, NO_COLOR: "1" } }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`          ${detail}`);
};

/*
  The working folder is named after the project, not something generic.

  A folder with no link adopts an existing project whose name matches it, so a
  folder called `source` silently attaches to any project called `source` —
  including one an earlier run of this very test left behind. `--name` is then
  ignored, because an existing link outranks it, and every assertion below
  fails against somebody else's data. Naming the folder uniquely means there
  is nothing for it to adopt.
*/
const project = `track-fetch-${Date.now().toString(36)}`;
const source = path.join(root, project);
mkdirSync(source, { recursive: true });

/* A project with two lines that hold different files. */
writeFileSync(path.join(source, "base.txt"), "base\n");
writeFileSync(path.join(source, "main-only.txt"), "on main\n");
const made = cbx(source, ["push", ".", "-m", "main baseline", "--name", project, "--no-licence"]);
if (made.code !== 0) {
  console.error("setup failed to create the project:\n" + made.out);
  process.exit(1);
}

cbx(source, ["track", "spike", "--new"]);
rmSync(path.join(source, "main-only.txt"));
writeFileSync(path.join(source, "spike-only.txt"), "on spike\n");
cbx(source, ["push", ".", "-m", "spike work", "--sync"]);

/* The reproduction: clone (lands on main), switch, fetch. */
const folder = path.join(root, "checkout");
cbx(root, ["clone", project, folder]);
record("a clone lands on main", existsSync(path.join(folder, "main-only.txt")));

cbx(folder, ["track", "spike"]);
cbx(folder, ["get", "."]);

record(
  "get fetches the line the folder is on, not the project's newest version",
  existsSync(path.join(folder, "spike-only.txt")) &&
    !existsSync(path.join(folder, "main-only.txt")),
  `holds: ${existsSync(path.join(folder, "spike-only.txt")) ? "spike-only " : ""}` +
    `${existsSync(path.join(folder, "main-only.txt")) ? "main-only" : ""}`,
);

const after = cbx(folder, ["track"]).out;
record(
  "and the folder still says it saves to that line",
  after.includes("spike"),
  `track reported: ${after.trim().split("\n")[0]}`,
);

/* Fetching twice must not drift. */
cbx(folder, ["get", "."]);
record(
  "a second fetch changes neither the files nor the line",
  existsSync(path.join(folder, "spike-only.txt")) &&
    !existsSync(path.join(folder, "main-only.txt")) &&
    cbx(folder, ["track"]).out.includes("spike"),
);

/* And the one-step form. */
const direct = path.join(root, "direct");
cbx(root, ["clone", project, direct, "--track", "spike"]);
record(
  "clone --track fetches that line and records it",
  existsSync(path.join(direct, "spike-only.txt")) &&
    !existsSync(path.join(direct, "main-only.txt")) &&
    cbx(direct, ["track"]).out.includes("spike"),
);

const missing = cbx(root, ["clone", project, path.join(root, "nope"), "--track", "nosuchline"]);
record(
  "a line that does not exist is refused rather than silently falling back",
  missing.code !== 0 && /no line called/i.test(missing.out),
  missing.out.trim().split("\n").pop(),
);

const removed = cbx(root, ["delete", project], `${project}\n`);
record(
  "the test removes the project it made",
  /Deleted/i.test(removed.out),
  removed.out.trim().split("\n").pop(),
);
await autoClean(root);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
