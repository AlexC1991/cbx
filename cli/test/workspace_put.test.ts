import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { batches, editKey, encodeFile, projectPath } from "../dist/cli/src/workspace_put.js";

test("text travels as text; NUL bytes or invalid UTF-8 travel as base64", () => {
  assert.deepEqual(encodeFile(new TextEncoder().encode("café\n")), { content: "café\n" });
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]);
  assert.deepEqual(encodeFile(png), { contentBase64: Buffer.from(png).toString("base64") });
  const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
  assert.deepEqual(encodeFile(latin1), { contentBase64: "Y2Fm6Q==" });
});

test("paths become project-relative with forward slashes, and nothing outside the folder is taken", () => {
  const root = resolve("project-root");
  assert.equal(projectPath(root, join("website", "public", "og.png")), "website/public/og.png");
  assert.equal(projectPath(root, join(root, "cli", "src", "a.ts")), "cli/src/a.ts");
  assert.throws(() => projectPath(root, join("..", "elsewhere.txt")), /outside/);
  assert.throws(() => projectPath(root, "."), /outside/);
});

test("edits split at 32 files, 1 MiB of content, or 1.5 MiB of JSON", () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ path: `f${i}.txt`, content: "x", expectedSha256: null }));
  assert.deepEqual(batches(many, new Map()).map((b) => b.length), [32, 32, 6]);

  const half = 600 * 1024;
  const big = ["a.bin", "b.bin", "c.bin"].map((path) => ({ path, contentBase64: "A".repeat(8), expectedSha256: null }));
  const sizes = new Map(big.map((c) => [c.path, half]));
  assert.deepEqual(batches(big, sizes).map((b) => b.map((c) => c.path)), [["a.bin"], ["b.bin"], ["c.bin"]]);

  // Small on disk but heavy once escaped: JSON size splits them.
  const quoted = ["q1", "q2"].map((path) => ({ path, content: '"'.repeat(500 * 1024), expectedSha256: null }));
  assert.deepEqual(batches(quoted, new Map([["q1", 500 * 1024], ["q2", 500 * 1024]])).map((b) => b.length), [1, 1]);
});

test("the same edit at the same revision gets the same key; anything different gets another", () => {
  const change = [{ path: "a.txt", content: "one", expectedSha256: null }];
  const key = editKey(4, change);
  assert.match(key, /^put-4-[a-f0-9]{40}$/);
  assert.equal(editKey(4, change), key);
  assert.notEqual(editKey(5, change), key);
  assert.notEqual(editKey(4, [{ path: "a.txt", content: "two", expectedSha256: null }]), key);
});
