/*
  Exactly-once from the user's point of view.

  Two ways the same attempt reaches the service twice: two clients racing, and
  one client that committed on the server but never recorded it locally. Both
  must produce one version, not two.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { assertSafeTarget, autoClean, scratchRoot } from "./live.mjs";
import { linkFile, linkIn } from "./links.mjs";

assertSafeTarget();
const run = promisify(execFile);
const root = path.resolve(scratchRoot("suite-attempt"));
mkdirSync(root, { recursive: true });
const API = "https://api.coderook.com";
const token = readFileSync(
  path.join(process.env.APPDATA, "CodeRook", "token"), "utf8").trim();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");

const api = async (route, method = "GET") =>
  (await fetch(`${API}${route}`, { method, headers })).json().catch(() => null);

const env = (home) => ({
  ...process.env, CODEROOK_CONFIG_DIR: home, CODEROOK_TOKEN: token, NO_COLOR: "1",
});

function rook(cwd, home, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [entry, ...args],
      { cwd, encoding: "utf8", env: env(home) }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** The same, but asynchronous, so two can genuinely overlap. */
async function rookAsync(cwd, home, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry, ...args],
      { cwd, env: env(home), maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`          ${String(detail).replace(/\n/g, "\n          ")}`);
}

const countVersions = async (repositoryId) =>
  (await api(`/v1/repositories/${repositoryId}/versions`)).versions.length;

const stamp = Date.now().toString(36);
const sweep = autoClean((slug) => slug.endsWith(`-${stamp}`) && slug.startsWith("attempt-"), root);

// ── two clients send the same attempt at the same moment ────────────────────

{
  const slug = `attempt-race-${stamp}`;
  const folder = path.join(root, slug);
  const home = path.join(root, `ar-cfg-${stamp}`);
  mkdirSync(folder, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(folder, "app.txt"), "one\n");
  rook(folder, home, ["submit", "-m", "v1"]);
  const link = linkIn(home, folder);

  // Same folder, same base, same content, same message — so both runs derive
  // the same attempt name and the service should collapse them.
  writeFileSync(path.join(folder, "app.txt"), "two\n");
  const before = await countVersions(link.repositoryId);
  const [left, right] = await Promise.all([
    rookAsync(folder, home, ["submit", "-m", "the very same attempt"]),
    rookAsync(folder, home, ["submit", "-m", "the very same attempt"]),
  ]);
  const after = await countVersions(link.repositoryId);
  record("two identical attempts at once create one version", after === before + 1,
    `versions ${before} -> ${after}\nleft:  ${left.out.trim().slice(0, 160)}\nright: ${right.out.trim().slice(0, 160)}`);
  record("both callers are told it succeeded",
    left.code === 0 && right.code === 0,
    `left=${left.code} right=${right.code}`);
  await api(`/v1/repositories/${link.repositoryId}`, "DELETE");
}

// ── the server committed, the client never recorded it ──────────────────────

{
  const slug = `attempt-crash-${stamp}`;
  const folder = path.join(root, slug);
  const home = path.join(root, `ac-cfg-${stamp}`);
  mkdirSync(folder, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(folder, "app.txt"), "one\n");
  rook(folder, home, ["submit", "-m", "v1"]);

  /* This folder's own record, which is what a lost local write loses. */
  const links = linkFile(home, folder);
  const repositoryId = linkIn(home, folder).repositoryId;
  copyFileSync(links, `${links}.snapshot`);

  writeFileSync(path.join(folder, "app.txt"), "two\n");
  const saved = rook(folder, home, ["submit", "-m", "committed but never recorded"]);
  const versionsAfterFirst = await countVersions(repositoryId);

  /*
    The version is on the account, but this machine never learned that — the
    state write is where a crash between commit and record leaves things.
    Putting the file back is exactly that state.
  */
  copyFileSync(`${links}.snapshot`, links);

  const retry = rook(folder, home, ["submit", "-m", "committed but never recorded"]);
  const versionsAfterRetry = await countVersions(repositoryId);

  record("the first save really did commit", /Saved v/.test(saved.out),
    saved.out.trim().slice(0, 200));
  record("retrying after a lost local write makes no second version",
    versionsAfterRetry === versionsAfterFirst,
    `after first ${versionsAfterFirst}, after retry ${versionsAfterRetry}\n${retry.out.trim().slice(0, 300)}`);
  record("and the retry repairs the local record",
    linkIn(home, folder).sequence === versionsAfterFirst,
    retry.out.trim().slice(0, 200));
  await api(`/v1/repositories/${repositoryId}`, "DELETE");
}

await sweep();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
