/**
 * A script that goes into a bundle executable comes out executable.
 *
 * The bundle has always recorded each file's mode, and unbundling never put
 * it back: on Linux a `0755` script came back `0644` and needed chmod (field
 * report 2, 2026-10-06). Windows has no execute bit to keep, so the check
 * only means something elsewhere.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectEntries, packBundle, unpackBundle } from "../dist/core/cbx.js";

test("unbundling restores the executable bit", { skip: process.platform === "win32" && "Windows has no execute bit" }, async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cbx-mode-"));
  try {
    const root = path.join(scratch, "src");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
    await writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(path.join(root, "run.sh"), 0o755);
    await writeFile(path.join(root, "notes.txt"), "plain\n");
    await chmod(path.join(root, "notes.txt"), 0o644);

    const target = path.join(scratch, "t.cbx");
    await packBundle({ root, target, entries: await collectEntries(root), sourceName: "t" });
    const out = path.join(scratch, "out");
    await unpackBundle(target, out);

    assert.equal((await stat(path.join(out, "run.sh"))).mode & 0o777, 0o755);
    assert.equal((await stat(path.join(out, "notes.txt"))).mode & 0o111, 0, "a plain file stays plain");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
