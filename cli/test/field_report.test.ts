/**
 * Rough edges found using the CLI for a day from Linux.
 *
 * Each of these sent somebody to fix the wrong thing: a limit that arrived as
 * a schema error after the upload plan, and a healthy network reported as two
 * words with no cause.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { describeError } from "../src/network.ts";

const cli = path.resolve("dist/cli/src/cli.js");
const home = mkdtempSync(path.join(tmpdir(), "coderook-field-"));

test("a message over 240 characters is refused before anything is scanned", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "cbx-long-message-"));
  try {
    const run = spawnSync(process.execPath, [cli, "submit", folder, "-m", "x".repeat(300)], {
      encoding: "utf8",
      env: { ...process.env, CODEROOK_TOKEN: "", CODEROOK_CONFIG_DIR: home },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /The message is 300 characters; the limit is 240/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("fetch failed says why", () => {
  const failed = Object.assign(new TypeError("fetch failed"), {
    cause: {
      code: "ETIMEDOUT",
      errors: [
        { code: "ETIMEDOUT", address: "172.67.133.187" },
        { code: "ENETUNREACH", address: "2606:4700::1" },
      ],
    },
  });
  const text = describeError(failed);
  assert.match(text, /Could not reach CodeRook/);
  assert.match(text, /ETIMEDOUT 172\.67\.133\.187/);
  assert.match(text, /ENETUNREACH 2606:4700::1/);
});

test("a deadline says it was a deadline", () => {
  const late = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.match(describeError(late), /did not answer in time/);
});

test("anything else keeps its own message", () => {
  assert.equal(describeError(new Error("That token was not accepted. Run: cbx sign-in")), "That token was not accepted. Run: cbx sign-in");
});
