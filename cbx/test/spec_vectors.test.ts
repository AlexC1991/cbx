/**
 * The format specification, checked against the code and against itself.
 *
 * Vectors are read out of spec/FORMAT.md rather than copied here, so the
 * document cannot say one thing while the test checks another. Where the
 * spec gives an algorithm (the gear table, the cut points, canonical trees
 * and saves), this file implements it again from the text alone and compares
 * that too: a vector that matches the code but not the written rules would
 * mean the rules are wrong, and somebody building from them would never get
 * the same ids.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chunkFrame, openChunkFrame } from "../dist/core/cbx.js";
import { chunkBoundaries, profileForFileSize, MEDIUM_CHUNK_PROFILE, HUGE_CHUNK_PROFILE } from "../dist/shared/chunking.js";
import { whyUnsafe } from "../dist/shared/safe_path.js";
import { init } from "../dist/local/history.js";
import { mergeText } from "../dist/local/merge_text.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = await readFile(path.join(here, "..", "spec", "FORMAT.md"), "utf8");
const vectors = new Map<string, any>();
for (const found of spec.matchAll(/```json cbx-vector=([\w-]+)\r?\n([\s\S]*?)```/g)) {
  vectors.set(found[1]!, JSON.parse(found[2]!));
}
const vector = (name: string) => {
  const found = vectors.get(name);
  assert.ok(found, `spec/FORMAT.md has no vector called ${name}`);
  return found;
};
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/* The gear table and cut points, written again from sections 4.1 and 4.2. */
function gearFromSpec(): number[] {
  const table: number[] = [];
  let seed = 0x9e3779b9;
  for (let at = 0; at < 256; at += 1) {
    seed = Number((BigInt(seed) * 1103515245n + 12345n) % 4294967296n);
    table.push(seed);
  }
  return table;
}

function cutsFromSpec(bytes: Uint8Array, profile: { minSize: number; targetSize: number; maxSize: number; strictMask: number; looseMask: number }): number[] {
  const gear = gearFromSpec();
  const cuts: number[] = [];
  let from = 0;
  let hash = 0;
  for (let at = 0; at < bytes.length; at += 1) {
    hash = ((hash * 2) + gear[bytes[at]!]!) % 4294967296;
    const size = at - from + 1;
    if (size < profile.minSize) continue;
    const mask = size < profile.targetSize ? profile.strictMask : profile.looseMask;
    if (size >= profile.maxSize || (hash & mask) >>> 0 === 0) {
      cuts.push(at + 1);
      from = at + 1;
      hash = 0;
    }
  }
  if (!cuts.length || cuts[cuts.length - 1] !== bytes.length) cuts.push(bytes.length);
  return cuts;
}

function generated(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let x = 1;
  for (let at = 0; at < length; at += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bytes[at] = x >>> 24;
  }
  return bytes;
}

test("the spec's vectors are all present", () => {
  for (const name of ["chunk-frame", "gear", "profiles", "chunking", "tree", "save", "pack", "merge"]) vector(name);
});

test("chunk frame: written byte for byte, read back and checked", () => {
  const { raw_hex, name, frame_hex } = vector("chunk-frame");
  const raw = Buffer.from(raw_hex, "hex");
  assert.equal(sha(raw), name);
  assert.equal(chunkFrame(raw).frame.toString("hex"), frame_hex);
  assert.ok(openChunkFrame(Buffer.from(frame_hex, "hex"), name).equals(raw));
  /* Each check in section 3.2 refuses a frame that fails it. */
  const damaged = Buffer.from(frame_hex, "hex");
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => openChunkFrame(damaged, name), /damaged/);
  assert.throws(() => openChunkFrame(Buffer.from(frame_hex, "hex"), "0".repeat(64)), /identity/);
});

test("gear table: the formula gives the listed entries", () => {
  const { first, last } = vector("gear");
  const table = gearFromSpec();
  assert.deepEqual(table.slice(0, 4).map((value) => value.toString(16).padStart(8, "0")), first);
  assert.equal(table[255]!.toString(16), last);
});

test("profiles: chosen by size as the table says", () => {
  const { sizes, ids } = vector("profiles");
  assert.deepEqual(sizes.map((size: number) => profileForFileSize(size)?.id ?? null), ids);
});

test("cut points: the code and the written algorithm agree with the vector", () => {
  const expected = vector("chunking");
  const bytes = generated(expected.length);
  assert.equal(sha(bytes), expected.sha256);
  for (const profile of [MEDIUM_CHUNK_PROFILE, HUGE_CHUNK_PROFILE]) {
    assert.deepEqual(chunkBoundaries(bytes, profile), expected[profile.id], `${profile.id} from the code`);
  }
  /* The written algorithm is slow in plain arithmetic; the first 6 MiB are enough to prove it. */
  const part = bytes.subarray(0, 6 * 1024 * 1024);
  const fromCode = chunkBoundaries(part, MEDIUM_CHUNK_PROFILE);
  assert.deepEqual(cutsFromSpec(part, MEDIUM_CHUNK_PROFILE), fromCode, "the written algorithm");
  assert.deepEqual(fromCode.slice(0, -1), expected["fastcdc-v2-medium"].filter((cut: number) => cut < part.length));
});

test("trees and saves: canonical JSON from the spec's key order gives the listed ids", async () => {
  const tree = vector("tree");
  assert.equal(sha(tree.json), tree.id);
  const parsed = JSON.parse(tree.json);
  const rebuilt = JSON.stringify({
    format: "cbx-tree",
    version: 1,
    files: parsed.files.map((file: any) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      executable: file.executable,
      chunks: file.chunks,
    })),
  });
  assert.equal(rebuilt, tree.json);

  const saved = vector("save");
  const record = JSON.stringify({ format: "cbx-save", version: 1, ...saved.record });
  assert.equal(sha(record), saved.id);

  /* And the implementation makes exactly these, with its pack. */
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-spec-"));
  try {
    const repository = await init(root);
    const blob = await repository.objects.put(Buffer.from("hello\n"));
    const treeId = await repository.writeTree(
      parsed.files.map((file: any) => ({ ...file, chunks: file.chunks.length ? [blob] : [] })).reverse(),
    );
    assert.equal(treeId, tree.id);
    const made = await repository.writeSave({ format: "cbx-save", version: 1, ...saved.record });
    assert.equal(made.id, saved.id);
    await repository.objects.flush();
    const pack = vector("pack");
    const packs = path.join(root, ".cbx", "objects", "packs");
    assert.deepEqual((await readdir(packs)).sort(), [`${pack.id}.idx`, `${pack.id}.pack`]);
    assert.equal(await readFile(path.join(packs, `${pack.id}.idx`), "utf8"), pack.idx);
    assert.equal(sha(await readFile(path.join(packs, `${pack.id}.pack`))), pack.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merge: the listed results, and conflict markers exactly as section 8.2 gives them", () => {
  const merge = vector("merge");
  assert.deepEqual(mergeText(merge.base, merge.ours, merge.theirs), { text: merge.result, conflicts: 0 });
  assert.deepEqual(mergeText(merge.conflict_base, merge.conflict_ours, merge.conflict_theirs), {
    text: merge.conflict_result,
    conflicts: 1,
  });
});

test("paths: the names section 6.2 refuses are refused", () => {
  for (const bad of [".cbx/lines/main", "a/.CBX/x", ".cbx. /x", ".git/config", "GIT~1/config", "../x", "/abs", "C:/x", "a/../b", ""]) {
    assert.notEqual(whyUnsafe(bad), null, bad);
  }
  for (const fine of ["a.cbx", "cbx/x", ".cbxrc", ".github/x", "src/a.ts"]) {
    assert.equal(whyUnsafe(fine), null, fine);
  }
});
