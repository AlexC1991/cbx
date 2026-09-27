import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { changedFiles, readRules } from "../dist/core/worktree.js";

/**
 * Whether an untouched file is recognised as untouched, at any size.
 *
 * It was not, past four megabytes, and the way it failed is worth keeping.
 * `measure` reads a file to count its lines and stops doing so above a limit,
 * which is sensible — a gigabyte does not belong in memory to be counted. But
 * the same early return also gave back no digest, and the digest is what the
 * comparison uses to decide a file is unchanged. An empty string never equals
 * a recorded digest, so the file was reported as changed every single time.
 *
 * The symptom was not a crash. A project holding two large files listed them
 * as outstanding after every save, beside a panel correctly stating the
 * account already held them, and refreshing recomputed the same empty answer
 * — so the one action a person would take to fix it confirmed the fault
 * instead. The bytes were safe throughout; only the question "is there
 * anything to send" was answered wrongly, forever, in the direction of
 * offering to send a gigabyte again.
 *
 * The sizes below straddle the limit deliberately: one under it, taking the
 * counted path, and one over it, taking the streamed one.
 */
const LIMIT = 4 * 1024 * 1024;

/** A folder holding files, and the record of what was put there. */
async function project(
  sizes: Record<string, number>,
): Promise<{ folder: string; record: Map<string, string> }> {
  const folder = await mkdtemp(path.join(tmpdir(), "sizes-"));
  const record = new Map<string, string>();
  for (const [name, size] of Object.entries(sizes)) {
    /*
      Filled with a repeating byte rather than random: the point is the size,
      and a gigabyte of randomness costs more to make than the test saves.
    */
    const body = Buffer.alloc(size, "x");
    await writeFile(path.join(folder, name), body);
    record.set(name, createHash("sha256").update(body).digest("hex"));
  }
  return { folder, record };
}

test("a file nobody touched is unchanged, on either side of the limit", async () => {
  const { folder, record } = await project({
    "under.bin": LIMIT - 1024,
    "over.bin": LIMIT * 2,
  });
  try {
    const changed = await changedFiles(
      folder,
      await readRules(folder),
      record,
      "add-and-update",
    );
    assert.deepEqual(
      changed.map((one) => one.path),
      [],
      "nothing was edited, so nothing should be offered for upload",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a large file that really did change is still noticed", async () => {
  /*
    The fix must not be "call everything unchanged". Skipping the digest for
    large files would make this pass by never reporting anything, which is the
    same bug pointing the other way and loses work rather than re-sending it.
  */
  const { folder, record } = await project({ "over.bin": LIMIT * 2 });
  try {
    await writeFile(path.join(folder, "over.bin"), Buffer.alloc(LIMIT * 2, "y"));
    const changed = await changedFiles(
      folder,
      await readRules(folder),
      record,
      "add-and-update",
    );
    assert.deepEqual(changed.map((one) => one.path), ["over.bin"]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a large file absent from the record is new, not unchanged", async () => {
  const { folder } = await project({ "over.bin": LIMIT * 2 });
  try {
    const changed = await changedFiles(
      folder,
      await readRules(folder),
      new Map(),
      "add-and-update",
    );
    assert.deepEqual(changed.map((one) => one.path), ["over.bin"]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a large file is still reported as binary", async () => {
  /*
    The digest is now taken for these, but the lines are still not counted —
    that limit was there for a reason and this must not have quietly removed
    it by reading the whole file after all.
  */
  const { folder } = await project({ "over.bin": LIMIT * 2 });
  try {
    const [file] = await changedFiles(
      folder,
      await readRules(folder),
      new Map(),
      "add-and-update",
    );
    assert.equal(file?.binary, true);
    assert.equal(file?.added, 0, "no line count is attempted past the limit");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
