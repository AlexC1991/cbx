import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.CODEROOK_CONFIG_DIR = await mkdtemp(path.join(tmpdir(), "coderook-cli-"));

const { storeToken, loadToken, clearToken, readLink, writeLink, configDirectory } =
  await import("../dist/cli/src/config.js");

test("the token is stored where only its owner can read it", async () => {
  await storeToken("  tok_example  ");
  assert.equal(await loadToken(), "tok_example");

  const file = path.join(configDirectory(), "token");
  const info = await stat(file);
  if (process.platform !== "win32") {
    // Windows has no POSIX mode; everywhere else this is what keeps the
    // credential out of other accounts' reach.
    assert.equal(info.mode & 0o777, 0o600);
  }
  assert.equal((await readFile(file, "utf8")).trim(), "tok_example");
});

test("the environment wins, so automation needs nothing on disk", async () => {
  await storeToken("from_disk");
  process.env.CODEROOK_TOKEN = "from_environment";
  assert.equal(await loadToken(), "from_environment");
  delete process.env.CODEROOK_TOKEN;
  assert.equal(await loadToken(), "from_disk");
});

test("signing out removes the token", async () => {
  await storeToken("tok_example");
  await clearToken();
  assert.equal(await loadToken(), "");
});

test("a folder remembers which project it saves into", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "project-"));
  assert.equal(await readLink(folder), null);
  await writeLink(folder, {
    repositoryId: "abc",
    slug: "demo",
    sequence: 3,
    manifest: { "a.txt": "deadbeef" },
  });
  const link = await readLink(folder);
  assert.equal(link?.slug, "demo");
  assert.equal(link?.sequence, 3);
  // Paths are matched case-insensitively, because Windows does.
  assert.equal((await readLink(folder.toUpperCase()))?.slug, "demo");
});

test("a folder remembers which line it saves onto, and defaults to main", async () => {
  /*
    The line is a fact about this copy rather than about the account: two
    checkouts of one project can sit on different lines, which is most of the
    point of having them. A link written before lines existed carries no
    track and has to keep meaning `main`, so an older folder needs no
    migration to go on behaving as it did.
  */
  const folder = await mkdtemp(path.join(tmpdir(), "track-"));
  await writeLink(folder, { repositoryId: "abc", slug: "demo", sequence: 1 });
  assert.equal((await readLink(folder))?.track, undefined);

  const older = await readLink(folder);
  assert.ok(older);
  await writeLink(folder, { ...older, track: "spike" });
  assert.equal((await readLink(folder))?.track, "spike");

  // And switching back is the same cheap write, not a fetch.
  await writeLink(folder, { ...older, track: "main" });
  assert.equal((await readLink(folder))?.track, "main");
});

test("an observed Track head does not replace the workspace base Version", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "ancestry-"));
  await writeLink(folder, {
    repositoryId: "abc",
    slug: "demo",
    sequence: 3,
    baseVersionId: "version-3",
    observedHeadVersionId: "version-5",
    manifest: { "a.txt": "deadbeef" },
  });

  const link = await readLink(folder);
  assert.equal(link?.baseVersionId, "version-3");
  assert.equal(link?.versionId, "version-3");
  assert.equal(link?.observedHeadVersionId, "version-5");
});

test("older links migrate their version identity into the base field", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "ancestry-legacy-"));
  await writeLink(folder, {
    repositoryId: "abc",
    slug: "demo",
    sequence: 2,
    versionId: "legacy-version-2",
    manifest: {},
  });
  assert.equal((await readLink(folder))?.baseVersionId, "legacy-version-2");
});

test("the assistant server reports the version that was published", async () => {
  /*
    It announced a literal, and the literal went stale within one release: the
    server told Claude Code it was 0.13.0 while the package on npm was 0.14.0.
    An assistant deciding what a tool can do from a version it was told is
    being told the wrong thing.

    The CLI already reads its own version from the package for exactly this
    reason — the comment beside it says a hardcoded copy had drifted before.
    This checks the two agree rather than trusting them to.
  */
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const declared = (require("../package.json") as { version: string }).version;

  const source = await readFile(
    new URL("../src/mcp.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /serverInfo: \{ name: "coderook", version: serverVersion \}/);
  assert.doesNotMatch(source, /version: "\d+\.\d+\.\d+"/);
  assert.match(declared, /^\d+\.\d+\.\d+$/);
});
