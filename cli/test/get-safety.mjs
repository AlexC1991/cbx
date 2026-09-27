/*
  What `get` does to everything the version does not contain.

  Fetching replaces the folder. The question is whether "the folder" means the
  files the version holds, or every byte in the directory — including the
  ignored working files, the git repository and the local credentials that
  were deliberately never uploaded.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { assertSafeTarget, autoClean, scratchRoot, versionFilePayload } from "./live.mjs";
import { linkIn } from "./links.mjs";

assertSafeTarget();
const root = path.resolve(scratchRoot("suite-get"));
mkdirSync(root, { recursive: true });
const token = readFileSync(
  path.join(process.env.APPDATA, "CodeRook", "token"), "utf8").trim();
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");
const API = "https://api.coderook.com";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

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
  if (!ok && detail) console.log(`          ${detail}`);
};

const stamp = Date.now().toString(36);
const slug = `getsafe-${stamp}`;
const sweep = autoClean((one) => one === slug, root);
const folder = path.join(root, slug);
const home = path.join(root, `gs-cfg-${stamp}`);
mkdirSync(folder, { recursive: true });
mkdirSync(home, { recursive: true });

// Tracked content, plus the things a real project has that are never uploaded.
writeFileSync(path.join(folder, "app.txt"), "one\n");
writeFileSync(path.join(folder, ".gitignore"), "node_modules/\n.env\nscratch.txt\n");
mkdirSync(path.join(folder, "node_modules", "left-pad"), { recursive: true });
writeFileSync(path.join(folder, "node_modules", "left-pad", "index.js"), "module.exports=1\n");
writeFileSync(path.join(folder, ".env"), "TOKEN=local-only\n");
writeFileSync(path.join(folder, "scratch.txt"), "notes I have not finished\n");
mkdirSync(path.join(folder, ".git"), { recursive: true });
writeFileSync(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");

rook(folder, home, ["submit", "-m", "v1"]);
const repositoryId = linkIn(home, folder).repositoryId;

// Somebody else moves the project on, so there is something to fetch.
const mira = path.join(root, `gs-mira-${stamp}`);
const homeM = path.join(root, `gs-m-${stamp}`);
mkdirSync(homeM, { recursive: true });
rook(root, homeM, ["clone", slug, mira]);
writeFileSync(path.join(mira, "app.txt"), "two\n");
rook(mira, homeM, ["submit", "-m", "mira"]);

const fetched = rook(root, home, ["get", folder]);
console.log(`  get: ${fetched.out.trim()}`);

record("the tracked file was updated",
  readFileSync(path.join(folder, "app.txt"), "utf8").trim() === "two");
record("ignored dependencies survive the fetch",
  existsSync(path.join(folder, "node_modules", "left-pad", "index.js")));
record("local credentials survive the fetch",
  existsSync(path.join(folder, ".env")));
record("unfinished untracked work survives the fetch",
  existsSync(path.join(folder, "scratch.txt")));
record("the git repository survives the fetch",
  existsSync(path.join(folder, ".git", "HEAD")));

// The other half: what the project genuinely dropped must still go.
writeFileSync(path.join(mira, "extra.txt"), "temporary\n");
rook(mira, homeM, ["submit", "-m", "mira adds extra"]);
rook(root, home, ["get", folder]);
record("a file the project added arrives", existsSync(path.join(folder, "extra.txt")));

const head = (await (await fetch(
  `${API}/v1/repositories/${repositoryId}/versions`, { headers })).json()).versions[0];
const remaining = (await (await fetch(
  `${API}/v1/repositories/${repositoryId}/versions/${head.id}/files`, { headers })).json())
  /*
    Rebuilt in whatever shape each file is actually stored in — see
    `versionFilePayload`. Sending `objectId` for a packed or chunked file is
    a 400 that this test used to swallow.
  */
  .files.filter((file) => file.path !== "extra.txt")
  .map(versionFilePayload);
const dropResponse = await fetch(`${API}/v1/repositories/${repositoryId}/versions`, {
  method: "POST", headers,
  body: JSON.stringify({ message: "mira removes extra", expectedHeadVersionId: head.id,
    sourceSize: remaining.reduce((sum, f) => sum + f.sourceSize, 0),
    storedSize: remaining.reduce((sum, f) => sum + f.storedSize, 0), files: remaining }),
});
if (!dropResponse.ok) {
  console.log(`  [setup] the drop version was refused: ${dropResponse.status} ` +
    (await dropResponse.text()).slice(0, 200));
}
rook(root, home, ["get", folder]);
record("a file the project dropped is removed", !existsSync(path.join(folder, "extra.txt")));
record("and the untracked files are still there",
  existsSync(path.join(folder, ".env")) && existsSync(path.join(folder, ".git", "HEAD")));

await fetch(`${API}/v1/repositories/${repositoryId}`, { method: "DELETE", headers });

await sweep();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
