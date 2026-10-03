/**
 * Where a folder's link lives, and moving it out of the one big file.
 *
 * Every folder this machine had ever linked used to share one file, read and
 * rewritten whole by every command. On a real machine it reached 419 MB across
 * 549 folders — 536 of which no longer existed — and cost about three seconds
 * per command to read and two and a half per save to write back. Two commands
 * in two folders also erased each other's changes, because each rewrote all of
 * it from what it had read.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const {
  DamagedLinkError,
  configDirectory,
  forgetLink,
  keyFor,
  linkFileFor,
  readLink,
  writeLink,
} = await import("../dist/cli/src/config.js");

/** A config folder of its own, and a project folder to link. */
async function fresh() {
  process.env.CODEROOK_CONFIG_DIR = await mkdtemp(path.join(tmpdir(), "coderook-links-"));
  const folder = await mkdtemp(path.join(tmpdir(), "coderook-linked-"));
  return { home: configDirectory(), folder };
}

const manifest = { "a.txt": "aaa", "b.txt": "bbb" };
const linked = (extra = {}) => ({
  repositoryId: "repo-1",
  slug: "demo",
  sequence: 3,
  versionId: "v-3",
  manifest,
  ...extra,
});

test("a folder's link is its own small file, not a share of one big one", async () => {
  const { home, folder } = await fresh();
  await writeLink(folder, linked());
  assert.equal((await readLink(folder))?.slug, "demo");
  assert.deepEqual(await readdir(home), ["links"]);
  assert.ok((await stat(linkFileFor(folder))).size < 1024);
});

test("a file list is not written twice when both copies are the same", async () => {
  /* 467 of 549 real links held `local` identical to `manifest`. */
  const { folder } = await fresh();
  await writeLink(folder, linked({ local: { ...manifest } }));
  const onDisk = await readFile(linkFileFor(folder), "utf8");
  assert.equal(onDisk.split("aaa").length - 1, 1, onDisk);
  const back = await readLink(folder);
  assert.deepEqual(back?.local, manifest);
  back!.local!["a.txt"] = "changed";
  assert.equal(back?.manifest["a.txt"], "aaa", "two copies again once read");
});

test("a different local record is kept as it is", async () => {
  const { folder } = await fresh();
  await writeLink(folder, linked({ local: { "a.txt": "aaa" } }));
  assert.deepEqual((await readLink(folder))?.local, { "a.txt": "aaa" });
});

test("two folders saving at once keep both of their changes", async () => {
  /* The lost update the single file had: each writer rewrote everyone. */
  const { folder } = await fresh();
  const other = await mkdtemp(path.join(tmpdir(), "coderook-linked-"));
  await Promise.all(
    Array.from({ length: 20 }, (_, at) =>
      writeLink(at % 2 ? folder : other, linked({ sequence: at })),
    ),
  );
  assert.ok(await readLink(folder));
  assert.ok(await readLink(other));
});

test("the old single file is split up on first use and moved aside", async () => {
  const { home, folder } = await fresh();
  const other = await mkdtemp(path.join(tmpdir(), "coderook-linked-"));
  await writeFile(
    path.join(home, "links.json"),
    JSON.stringify(
      {
        [keyFor(folder)]: linked({ local: { ...manifest } }),
        [keyFor(other)]: linked({ slug: "second" }),
      },
      null,
      2,
    ),
  );
  assert.equal((await readLink(folder))?.slug, "demo");
  assert.equal((await readLink(other))?.slug, "second", "every folder, not just the one asked about");
  const left = await readdir(home);
  assert.ok(left.includes("links.json.migrated"), left.join(", "));
  assert.ok(!left.includes("links.json"));
});

test("a link written while migrating is newer and is not overwritten", async () => {
  const { home, folder } = await fresh();
  await writeLink(folder, linked({ sequence: 9 }));
  await writeFile(
    path.join(home, "links.json"),
    JSON.stringify({ [keyFor(folder)]: linked({ sequence: 3 }) }),
  );
  const other = await mkdtemp(path.join(tmpdir(), "coderook-linked-"));
  await readLink(other); /* a miss elsewhere starts the migration */
  assert.equal((await readLink(folder))?.sequence, 9);
});

test("a forgotten folder is not brought back by a migration", async () => {
  const { home, folder } = await fresh();
  await writeFile(
    path.join(home, "links.json.migrating"),
    JSON.stringify({ [keyFor(folder)]: linked() }),
  );
  /* An interrupted migration: the claimed file is still there. */
  assert.equal(await forgetLink(folder), true);
  assert.equal(await readLink(folder), null);
  const other = await mkdtemp(path.join(tmpdir(), "coderook-linked-"));
  await readLink(other);
  assert.equal(await readLink(folder), null, "still forgotten after the migration ran");
});

test("a damaged link fails closed instead of looking unlinked", async () => {
  /*
    Read as absent, a linked folder looks new and the next save creates a
    second project beside the real one. The old code did exactly that.
  */
  const { folder } = await fresh();
  await writeLink(folder, linked());
  const file = linkFileFor(folder);
  const whole = await readFile(file, "utf8");
  await writeFile(file, whole.slice(0, whole.length / 2));
  await assert.rejects(readLink(folder), (error: Error) => {
    assert.ok(error instanceof DamagedLinkError);
    assert.match(error.message, /damaged/);
    assert.ok(error.message.includes(file), "names the file");
    return true;
  });
});

test("a damaged old file fails closed and is left where it was", async () => {
  const { home, folder } = await fresh();
  const legacy = path.join(home, "links.json");
  await mkdir(home, { recursive: true });
  await writeFile(legacy, '{"c:\\half": {"repositoryId": "r"');
  await assert.rejects(readLink(folder), DamagedLinkError);
  assert.ok((await readdir(home)).includes("links.json"), "nothing moved, nothing lost");
});

test("an unlinked folder on a machine with no old file is simply unlinked", async () => {
  const { folder } = await fresh();
  assert.equal(await readLink(folder), null);
  assert.equal(await forgetLink(folder), false);
});

test("a folder linked on one machine is recognised on another", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "coderook-shared-folder-"));
  await fresh();
  await writeLink(project, linked({ slug: "dual-boot" }));

  /* Another machine, or the same disk from another operating system. */
  await fresh();
  const found = await readLink(project);
  assert.equal(found?.slug, "dual-boot");
  assert.equal(found?.repositoryId, "repo-1");

  /* Git is told to leave it alone, and the copy carries no token. */
  assert.equal(await readFile(path.join(project, ".coderook", ".gitignore"), "utf8"), "*\n");
  assert.doesNotMatch(await readFile(path.join(project, ".coderook", "link.json"), "utf8"), /token/i);
});

test("unlinking on a machine is not overruled by the folder's copy", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "coderook-forget-folder-"));
  await fresh();
  await writeLink(project, linked({ slug: "forget-me" }));
  await forgetLink(project);
  assert.equal(await readLink(project), null);
  await assert.rejects(stat(path.join(project, ".coderook", "link.json")));
});
