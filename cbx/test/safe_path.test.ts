/**
 * Paths a version may not write, wherever they are written from.
 *
 * After Gitea's CVE-2026-60004, where repository content became a git hook.
 * The equivalent here was a version holding `.git/config`, fetched into a
 * folder that is a git checkout: the check refused `..` and nothing else, and
 * the file was renamed over the real one — where `core.fsmonitor` runs a
 * command on the next `git status`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Downloader } from "../dist/core/download.js";
import { inside, isGitDirectoryName, whyUnsafe } from "../dist/shared/safe_path.js";

test("git's own directory is refused in every spelling git itself refuses", () => {
  for (const name of [".git", ".GIT", ".Git", ".git.", ".git ", ".git::$INDEX_ALLOCATION", "git~1", "GIT~2"]) {
    assert.equal(isGitDirectoryName(name), true, name);
  }
  for (const name of [".github", ".gitignore", ".gitattributes", "git", "my.git", "git~notes"]) {
    assert.equal(isGitDirectoryName(name), false, name);
  }
  assert.match(whyUnsafe(".git/config") ?? "", /git's own directory/);
  assert.match(whyUnsafe("vendor/lib/.GIT/hooks/pre-commit") ?? "", /git's own directory/);
  assert.match(whyUnsafe(".git") ?? "", /git's own directory/);
});

test("climbing out is refused whichever separator carries it", () => {
  /* Split on `/` alone, the old check saw one name here; Windows sees three. */
  assert.match(whyUnsafe("a\\..\\..\\x") ?? "", /climbs out/);
  assert.match(whyUnsafe("../x") ?? "", /climbs out/);
  assert.match(whyUnsafe("/etc/passwd") ?? "", /absolute/);
  assert.match(whyUnsafe("C:\\Windows\\x") ?? "", /absolute/);
  assert.equal(whyUnsafe("src/.github/workflows/build.yml"), null);
  assert.equal(whyUnsafe("docs/..notes/readme.md"), null);
});

test("a checked path lands inside the folder it was given", () => {
  const root = path.resolve(tmpdir(), "coderook-inside");
  assert.equal(inside(root, "src/a.txt"), path.join(root, "src", "a.txt"));
  assert.throws(() => inside(root, "../outside.txt"), /unsafe path/);
  assert.throws(() => inside(root, ".git/config"), /unsafe path/);
});

test("a version holding .git/config is refused whole, and the checkout is untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-gitdir-"));
  await mkdir(path.join(root, ".git"), { recursive: true });
  const realConfig = "[core]\n\trepositoryformatversion = 0\n";
  await writeFile(path.join(root, ".git", "config"), realConfig);

  const planted = Buffer.from("[core]\n\tfsmonitor = calc.exe\n");
  const ordinary = Buffer.from("ordinary file\n");
  const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
  const fetched: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const route = new URL(String(input)).pathname;
    fetched.push(route);
    if (route.endsWith("/versions/version-1/files")) {
      return Response.json({
        files: [
          { path: "src/a.txt", objectId: "object-1", sha256: digest(ordinary), sourceSize: ordinary.byteLength },
          { path: ".git/config", objectId: "object-2", sha256: digest(planted), sourceSize: planted.byteLength },
        ],
      });
    }
    if (route.endsWith("/objects/object-1")) return new Response(ordinary);
    if (route.endsWith("/objects/object-2")) return new Response(planted);
    throw new Error(`unexpected test route ${route}`);
  };

  try {
    const downloader = new Downloader({
      origin: () => "https://bench.invalid",
      token: async () => "test-token",
    });
    await assert.rejects(
      downloader.run("repository-1", "version-1", root, () => undefined),
      /git's own directory/,
    );
    assert.equal(await readFile(path.join(root, ".git", "config"), "utf8"), realConfig);
    /* Refused before a byte of content was fetched, so nothing is half-written. */
    assert.equal(fetched.some((route) => route.includes("/objects/")), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
