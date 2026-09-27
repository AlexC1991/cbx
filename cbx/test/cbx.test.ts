import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectEntries,
  cutPoints,
  packBundle,
  readManifest,
  unpackBundle,
} from "../dist/core/cbx.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cbx-"));
  await writeFile(path.join(root, "readme.md"), "# hello\n".repeat(400));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "main.ts"), "export const x = 1;\n".repeat(300));
  // Two identical files, so deduplication has something to find.
  await writeFile(path.join(root, "src", "copy.ts"), "export const x = 1;\n".repeat(300));
  // Genuinely incompressible, so the codec rule has something to refuse.
  // A repeating arithmetic pattern would not do: zstd crushes those.
  await writeFile(path.join(root, "noise.bin"), randomBytes(64 * 1024));
  return root;
}

test("the header, manifest and footer are the prototype's", async () => {
  const root = await fixture();
  const target = path.join(root, "..", `${path.basename(root)}.cbx`);
  await packBundle({ root, target, entries: await collectEntries(root), sourceName: "t" });

  const bytes = await readFile(target);
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "CBX1");
  assert.equal(bytes.readUInt16LE(4), 1);
  assert.equal(bytes.subarray(24, 28).toString("latin1"), "CHNK");
  assert.equal(bytes.subarray(bytes.length - 52, bytes.length - 48).toString("latin1"), "CBXF");

  // The footer points at a manifest record that starts with MANF.
  const manifestOffset = Number(bytes.readBigUInt64LE(bytes.length - 48));
  assert.equal(bytes.subarray(manifestOffset, manifestOffset + 4).toString("latin1"), "MANF");
});

test("a bundle round-trips byte for byte", async () => {
  const root = await fixture();
  const target = `${root}.cbx`;
  const out = `${root}-out`;
  const entries = await collectEntries(root);
  await packBundle({ root, target, entries, sourceName: "t" });
  const result = await unpackBundle(target, out);

  assert.equal(result.files, entries.length);
  for (const relative of entries) {
    assert.deepEqual(
      await readFile(path.join(out, relative)),
      await readFile(path.join(root, relative)),
      relative,
    );
  }
});

test("identical files share one chunk", async () => {
  const root = await fixture();
  const target = `${root}-dedup.cbx`;
  const result = await packBundle({
    root,
    target,
    entries: await collectEntries(root),
    sourceName: "t",
  });
  assert.ok(result.duplicateBytes > 0, "the duplicate file should cost nothing");

  const manifest = await readManifest(target);
  assert.equal(manifest.chunking.algorithm, "fastcdc-v2");
  assert.equal(manifest.chunking.profile, "fastcdc-v2-huge");
  const main = manifest.files.find((file) => file.path === "src/main.ts")!;
  const copy = manifest.files.find((file) => file.path === "src/copy.ts")!;
  assert.deepEqual(main.chunks, copy.chunks);
});

test("high-entropy data is stored raw rather than grown", async () => {
  const root = await fixture();
  const target = `${root}-raw.cbx`;
  await packBundle({
    root,
    target,
    entries: ["noise.bin"],
    sourceName: "t",
  });
  const manifest = await readManifest(target);
  const [record] = Object.values(manifest.chunks);
  // codec 0 is "none": compression did not save the required two percent.
  assert.equal(record.codec, 0);
  assert.equal(record.stored_size, record.raw_size);
});

test("a damaged bundle is refused rather than half-extracted", async () => {
  const root = await fixture();
  const target = `${root}-bad.cbx`;
  await packBundle({ root, target, entries: ["readme.md"], sourceName: "t" });
  const bytes = await readFile(target);
  // Flip a byte inside the first chunk payload.
  bytes[120] = bytes[120]! ^ 0xff;
  await writeFile(target, bytes);
  await assert.rejects(() => unpackBundle(target, `${root}-bad-out`), /damaged|identity/);
});

test("a path that climbs out of the destination is refused", async () => {
  const root = await fixture();
  const target = `${root}-escape.cbx`;
  await packBundle({ root, target, entries: ["readme.md"], sourceName: "t" });
  const manifest = await readManifest(target);
  assert.ok(manifest.files.every((file) => !file.path.includes("..")));
});

test("cut points respect the minimum chunk size", async () => {
  const buffer = Buffer.alloc(3 * 1024 * 1024);
  for (let at = 0; at < buffer.length; at += 1) buffer[at] = (at * 31) & 0xff;
  let previous = 0;
  for (const cut of cutPoints(buffer)) {
    assert.ok(cut - previous >= 2 * 1024 * 1024, "chunks cannot be under the minimum");
    previous = cut;
  }
});
