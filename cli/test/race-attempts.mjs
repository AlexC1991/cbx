/*
  Two copies of one save, racing.

  The service collapses them by a name derived from the content, so exactly
  one Version exists whichever arrives first. That much is already proven. The
  open question is the losing caller: an earlier run of this exited non-zero
  once and the reason was never established, and six clean runs afterwards did
  not explain it.

  So this does not ask "did it happen again". It runs the race many times and
  records what every caller actually did — the exit code, which branch it
  reported, and how many Versions existed either side. An unexplained exit is
  then a captured exit rather than a memory.
*/
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { assertSafeTarget, autoClean, scratchRoot, liveToken, apiOrigin } from "./live.mjs";
import { firstLink } from "./links.mjs";

const run = promisify(execFile);
assertSafeTarget();
const root = path.resolve(scratchRoot("suite-race"));
mkdirSync(root, { recursive: true });
const token = liveToken();
const API = apiOrigin();
const headers = { authorization: `Bearer ${token}` };
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");

const ROUNDS = Number(process.env.RACE_ROUNDS ?? 12);
const RACERS = Number(process.env.RACE_RACERS ?? 3);

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`          ${String(detail).replace(/\n/g, "\n          ")}`);
};

async function rook(cwd, home, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry, ...args], {
      cwd, env: { ...process.env, CODEROOK_CONFIG_DIR: home, CODEROOK_TOKEN: token,
        NO_COLOR: "1" }, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const countVersions = async (repositoryId) =>
  (await (await fetch(`${API}/v1/repositories/${repositoryId}/versions`, { headers }))
    .json()).versions.length;

/** Which branch a caller reported taking, from what it printed. */
function classify(result) {
  if (result.code !== 0) return "failed";
  if (/Already saved as v/.test(result.out)) return "found-the-winner";
  if (/Saved v/.test(result.out)) return "made-it";
  if (/Nothing to submit/.test(result.out)) return "nothing-to-do";
  if (/kept as M-/.test(result.out)) return "diverted-to-a-merge";
  return "unrecognised";
}

const stamp = Date.now().toString(36);
const sweep = autoClean((slug) => slug.startsWith(`race${stamp}`), root);

const tally = new Map();
const oddities = [];
let doubled = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
  const slug = `race${stamp}-${round}`;
  const folder = path.join(root, slug);
  const home = path.join(root, `h-${round}-${stamp}`);
  mkdirSync(folder, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(folder, "app.txt"), "one\n");
  await rook(folder, home, ["submit", "-m", "v1"]);
  const repositoryId = firstLink(home).repositoryId;

  // Identical content, base and message, so every racer derives one name.
  writeFileSync(path.join(folder, "app.txt"), "two\n");
  const before = await countVersions(repositoryId);
  const racers = await Promise.all(
    Array.from({ length: RACERS }, () =>
      rook(folder, home, ["submit", "-m", "the very same attempt"])),
  );
  const after = await countVersions(repositoryId);

  if (after !== before + 1) doubled += 1;
  for (const racer of racers) {
    const branch = classify(racer);
    tally.set(branch, (tally.get(branch) ?? 0) + 1);
    if (racer.code !== 0 || branch === "unrecognised") {
      oddities.push({
        round,
        exit: racer.code,
        branch,
        versions: `${before} -> ${after}`,
        output: racer.out.trim().slice(0, 400),
      });
    }
  }
}

console.log(`\n  ${ROUNDS} rounds x ${RACERS} racers`);
for (const [branch, count] of [...tally].sort()) {
  console.log(`    ${String(count).padStart(3)}  ${branch}`);
}

record("every round produced exactly one new version", doubled === 0,
  `${doubled} round(s) produced a different number`);
record("every caller took a branch that is meant to exist",
  !tally.has("unrecognised"), `${tally.get("unrecognised") ?? 0} unrecognised`);
record("no caller failed", oddities.length === 0,
  oddities.map((one) =>
    `round ${one.round} · exit ${one.exit} · ${one.branch} · versions ${one.versions}\n${one.output}`,
  ).join("\n---\n"));

await sweep();
const failed = results.filter((one) => !one.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
