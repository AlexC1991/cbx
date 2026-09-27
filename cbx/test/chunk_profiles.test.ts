import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  chunkBoundaries,
  cutPoints,
  LEGACY_CHUNK_PROFILE,
  MEDIUM_CHUNK_PROFILE,
  LARGE_CHUNK_PROFILE,
  HUGE_CHUNK_PROFILE,
  MICRO_CHUNK_PROFILE,
  microchunkProfileForFileSize,
  profileForFileSize,
} from "../dist/shared/chunking.js";

const MIB = 1024 * 1024;

/** Deterministic high-entropy bytes; unlike randomBytes this is reproducible. */
function noise(size: number): Buffer {
  const body = Buffer.allocUnsafe(size);
  let state = 0x6d2b79f5;
  for (let at = 0; at < size; at += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    body[at] = state & 0xff;
  }
  return body;
}

function pieces(body: Buffer, profile = LARGE_CHUNK_PROFILE): Buffer[] {
  const result: Buffer[] = [];
  let from = 0;
  for (const to of chunkBoundaries(body, profile)) {
    result.push(body.subarray(from, to));
    from = to;
  }
  return result;
}

function digest(piece: Buffer): string {
  return createHash("sha256").update(piece).digest("hex");
}

test("the legacy profile is immutable and still reproduces its old boundaries", () => {
  const body = noise(12 * MIB);
  assert.deepEqual(cutPoints(body, LEGACY_CHUNK_PROFILE), [
    2_097_232,
    4_194_411,
    6_291_566,
    8_389_083,
    10_486_251,
  ]);
});

test("repository profiles are selected only by file size", () => {
  assert.equal(profileForFileSize(8 * MIB - 1), null);
  assert.equal(profileForFileSize(8 * MIB)?.id, MEDIUM_CHUNK_PROFILE.id);
  assert.equal(profileForFileSize(128 * MIB)?.id, LARGE_CHUNK_PROFILE.id);
  assert.equal(profileForFileSize(2 * 1024 * MIB)?.id, HUGE_CHUNK_PROFILE.id);
});

test("the advertised microchunk map uses one immutable cross-client profile", () => {
  assert.equal(microchunkProfileForFileSize(7 * MIB), null);
  assert.equal(microchunkProfileForFileSize(8 * MIB), MICRO_CHUNK_PROFILE);
  assert.equal(microchunkProfileForFileSize(8 * 1024 * MIB), MICRO_CHUNK_PROFILE);
  assert.equal(MICRO_CHUNK_PROFILE.targetSize, 1 * MIB);
  assert.equal(MICRO_CHUNK_PROFILE.maxSize, 4 * MIB);
});

test("every v2 profile respects its declared minimum and maximum", () => {
  const fixtures = [
    [MEDIUM_CHUNK_PROFILE, 20 * MIB],
    [LARGE_CHUNK_PROFILE, 80 * MIB],
    [HUGE_CHUNK_PROFILE, 96 * MIB],
  ] as const;
  for (const [profile, size] of fixtures) {
    const chunks = pieces(noise(size), profile);
    for (const piece of chunks.slice(0, -1)) {
      assert.ok(piece.length >= profile.minSize, `${profile.id} cut below minimum`);
      assert.ok(piece.length <= profile.maxSize, `${profile.id} cut above maximum`);
    }
    assert.ok(chunks.at(-1)!.length <= profile.maxSize);
  }
});

test("a small middle edit reuses the surrounding high-entropy chunks", () => {
  const original = noise(64 * MIB);
  const edited = Buffer.from(original);
  edited.fill(0xa5, 31 * MIB, 31 * MIB + 64 * 1024);

  const before = pieces(original).map(digest);
  const afterPieces = pieces(edited);
  const beforeSet = new Set(before);
  const newBytes = afterPieces
    .filter((piece) => !beforeSet.has(digest(piece)))
    .reduce((total, piece) => total + piece.length, 0);

  assert.ok(before.length >= 8, `expected several chunks, got ${before.length}`);
  assert.ok(
    newBytes <= 16 * MIB,
    `a 64 KiB edit required ${newBytes} new bytes instead of a bounded region`,
  );
});
