/*
  Refusing a build that is known to do damage.

  This is the only lever that reaches software already installed on somebody
  else's machine. It has to bite on the builds it is aimed at, stay off
  everything else, and — most importantly — leave an old build able to sign
  in, list its projects and get its work off that machine. Taking everything
  away would punish the person for a mistake that was ours.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertSafeTarget, autoClean, scratchRoot, liveToken, apiOrigin } from "./live.mjs";
import { firstLink } from "./links.mjs";

assertSafeTarget();
const root = path.resolve(scratchRoot("suite-floor"));
mkdirSync(root, { recursive: true });
const token = liveToken();
const API = apiOrigin();
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`          ${String(detail).replace(/\n/g, "\n          ")}`);
};

const meta = async (client) =>
  (await fetch(`${API}/v1/meta`, {
    headers: client ? { "x-coderook-client": client } : {},
  })).json();

const stamp = Date.now().toString(36);
const sweep = autoClean((slug) => slug === `floor-${stamp}`, root);

// ── the contract is readable before anybody has signed in ───────────────────

{
  const body = await meta(null);
  record("the contract is readable without a token",
    body.protocolVersion >= 1 && Boolean(body.upgradeUrl), JSON.stringify(body));
  record("it names a capability and its floors",
    typeof body.capabilities?.materialise === "object",
    JSON.stringify(body.capabilities));
}

// ── the service reads what a client says, and refuses to guess ──────────────

{
  const cases = [
    ["cli/0.7.0", "cli", "0.7.0"],
    ["desktop/0.4.0", "desktop", "0.4.0"],
    ["CLI/1.2.3", "cli", "1.2.3"],
    [null, "unknown", null],
    ["curl/8.4.0", "unknown", null],
    ["cli/banana", "unknown", null],
    ["cli", "unknown", null],
  ];
  for (const [sent, kind, version] of cases) {
    const you = (await meta(sent)).you;
    record(`identity · ${sent ?? "(nothing)"} reads as ${kind}`,
      you.kind === kind && you.version === version, JSON.stringify(you));
  }
}

// ── the real client identifies itself on its ordinary traffic ───────────────

{
  const home = path.join(root, `cfg-${stamp}`);
  mkdirSync(home, { recursive: true });
  const out = execFileSync(process.execPath, [entry, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, CODEROOK_CONFIG_DIR: home, CODEROOK_TOKEN: token, NO_COLOR: "1" },
  });
  record("a real command reaches the service and works", /Service: ok/.test(out), out.trim());

  // What it declares has to match what it actually is, or a floor set against
  // a version would be judging the wrong build.
  const version = execFileSync(process.execPath, [entry, "--version"], {
    encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
  }).trim();
  const declared = (await meta(`cli/${version}`)).you;
  record("its declared version parses as itself",
    declared.kind === "cli" && declared.version === version,
    `${version} -> ${JSON.stringify(declared)}`);
}

// ── an old build keeps what it needs to rescue its work ─────────────────────

{
  /*
    Whatever the floor eventually refuses, these have to keep working: signing
    in, seeing what is on the account, and taking a copy away. An old build
    that cannot do those is one somebody's work is trapped inside.
  */
  const home = path.join(root, `old-${stamp}`);
  mkdirSync(home, { recursive: true });
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [entry, ...args], {
        encoding: "utf8", env: { ...process.env, CODEROOK_CONFIG_DIR: home,
          CODEROOK_TOKEN: token, NO_COLOR: "1" } }) };
    } catch (error) {
      return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };
  record("signing in still answers", run("whoami").code === 0);
  record("the project list still answers", run("projects").code === 0);
}

/*
  The floor, exercised against the endpoint it protects rather than only the
  function that decides it. A refusal has to arrive as something the person
  can act on, and — just as importantly — the operations an old build needs to
  rescue its work have to survive it.
*/
{
  const home = path.join(root, `gate-${stamp}`);
  const folder = path.join(root, `floor-${stamp}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "app.txt"), "one\n");
  execFileSync(process.execPath, [entry, "submit", "-m", "v1"], {
    cwd: folder, encoding: "utf8",
    env: { ...process.env, CODEROOK_CONFIG_DIR: home, CODEROOK_TOKEN: token, NO_COLOR: "1" },
  });
  const link = firstLink(home);
  const version = (await (await fetch(
    `${API}/v1/repositories/${link.repositoryId}/versions`,
    { headers: { authorization: `Bearer ${token}` } })).json()).versions[0];

  const askFor = (client) =>
    fetch(`${API}/v1/repositories/${link.repositoryId}/versions/${version.id}` +
      `/file?path=${encodeURIComponent("app.txt")}`,
      { headers: { authorization: `Bearer ${token}`,
        ...(client ? { "x-coderook-client": client } : {}) } });

  const refused = await askFor("desktop/0.2.0");
  const body = await refused.json().catch(() => ({}));
  record("the build that destroyed folders is refused the bytes",
    refused.status === 426, `status ${refused.status}`);
  record("and the refusal says what to do about it",
    body.error?.code === "client_too_old" &&
      body.error?.minimumSupported === "0.3.0" &&
      body.error?.yourVersion === "0.2.0" &&
      typeof body.error?.upgradeUrl === "string",
    JSON.stringify(body.error));

  record("a build that writes folders safely is served",
    (await askFor("desktop/0.3.0")).status === 200);
  record("so is the current command line",
    (await askFor("cli/0.7.0")).status === 200);
  record("so is the website, which only shows the file",
    (await askFor("web/1.0.0")).status === 200);
  /*
    A client that will not say what it is is refused too, now that every
    build which writes folders does say. It costs the safe old builds their
    access along with the unsafe one — there is no way to tell them apart
    without the header, which is the reason the header exists.
  */
  const anonymous = await askFor(null);
  const anonymousBody = await anonymous.json().catch(() => ({}));
  record("a client that will not say what it is is refused",
    anonymous.status === 426, `status ${anonymous.status}`);
  record("and is told what would be accepted",
    String(anonymousBody.error?.minimumSupported ?? "").includes("cli 0.5.0"),
    JSON.stringify(anonymousBody.error));

  /*
    The point of refusing one capability rather than the client: somebody on a
    bad build must still be able to see what is on their account and get it
    off that machine.
  */
  const oldClient = { authorization: `Bearer ${token}`,
    "x-coderook-client": "desktop/0.2.0" };
  record("a refused build can still list its projects",
    (await fetch(`${API}/v1/repositories`, { headers: oldClient })).status === 200);
  record("a refused build can still read the version history",
    (await fetch(`${API}/v1/repositories/${link.repositoryId}/versions`,
      { headers: oldClient })).status === 200);
  record("a refused build can still read who it is signed in as",
    (await fetch(`${API}/v1/account`, { headers: oldClient })).status === 200);
}

await sweep();
const failed = results.filter((one) => !one.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`\n${failed.map((one) => `  ${one.name}`).join("\n")}`);
process.exit(failed.length ? 1 : 0);
