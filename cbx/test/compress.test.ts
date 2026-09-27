import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { encodeForUpload, looksCompressed } from "../dist/core/compress.js";
import {
  GZIP_REVIEW_EVERY,
  SAMPLE_BYTES,
  freshGzipVerdict,
  noteChunkOutcome,
  sampleSaysDoNotBother,
  sampleWindows,
  worthSampling,
} from "../dist/shared/compression_policy.js";

/**
 * What the desktop app sends, and what it does not bother compressing.
 *
 * Every upload used to go as raw bytes. The service has recorded a content
 * encoding per object since the beginning and the account overview reports
 * what compression saved — so it reported nothing, correctly, because nothing
 * was compressed. The cost was paid twice over: once in upload time, and again
 * in the storage the person is charged for.
 */
const text = (size: number) =>
  new TextEncoder().encode("the quick brown fox jumps over the lazy dog. ".repeat(size));

test("compresses ordinary text and can be read back", async () => {
  const original = text(400);
  const encoded = await encodeForUpload(original, "notes.txt", true);
  assert.equal(encoded.encoding, "gzip");
  assert.ok(encoded.body.byteLength < original.byteLength);
  /*
    The whole contract. The service stores these bytes and hands them back
    decoded, so a bundle that cannot be reversed is silent data loss rather
    than a failed optimisation.
  */
  assert.deepEqual(new Uint8Array(gunzipSync(encoded.body)), original);
});

test("names the digest of what actually travels", async () => {
  const encoded = await encodeForUpload(text(400), "notes.txt", true);
  /* The path carries the original's digest; this one describes the body. */
  assert.match(encoded.storedSha256, /^[0-9a-f]{64}$/);
});

test("leaves already-compressed formats alone", async () => {
  for (const name of ["photo.png", "clip.mp4", "archive.zip", "model.safetensors", "pack.cbx"]) {
    assert.equal(looksCompressed(name), true, name);
    const encoded = await encodeForUpload(text(400), name, true);
    assert.equal(encoded.encoding, "identity", name);
  }
});

test("does not keep a result that saved nothing", async () => {
  /*
    Measured rather than guessed. A .txt full of random bytes gets no smaller,
    and keeping it compressed would cost the service a decode on every read
    for the rest of the object's life in exchange for nothing.
  */
  const random = new Uint8Array(64 * 1024);
  for (let at = 0; at < random.length; at += 1) random[at] = Math.floor(Math.random() * 256);
  const encoded = await encodeForUpload(random, "random.txt", true);
  assert.equal(encoded.encoding, "identity");
});

test("leaves tiny files alone", async () => {
  const encoded = await encodeForUpload(text(2), "small.txt", true);
  assert.equal(encoded.encoding, "identity");
});

test("sends plainly when the service does not record gzip", async () => {
  /*
    An encoding the deployment cannot store is refused outright, so this is not
    a preference — guessing wrong turns every upload into a failed one.
  */
  const encoded = await encodeForUpload(text(400), "notes.txt", false);
  assert.equal(encoded.encoding, "identity");
});

/*
  Sampling before committing.

  A project of thirteen `.gguf` model weights — 10.6 GB — was deflated in full
  at level 6 to learn that it compressed by 3.3%, and the result was discarded.
  That was 87% of everything the save did before sending a byte, and a save runs
  the pipeline twice, so it was spent twice. The project never finished saving.
*/

/** Incompressible, and the same bytes every run — a fixture, not a coin toss. */
const noise = (size: number) => {
  const out = new Uint8Array(size);
  let state = 0x2f6e2b1;
  for (let at = 0; at < size; at += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[at] = state & 0xff;
  }
  return out;
};

test("a format nobody listed is dropped after a sample, not after all of it", async () => {
  /*
    The whole point. `.gguf` is in the list now, but the next unlisted format
    is not, so the guard that matters is the one that does not know the name.
  */
  const original = noise(SAMPLE_BYTES * 16);
  const encoded = await encodeForUpload(original, "weights.unheardof", true);
  assert.equal(encoded.encoding, "identity");
  assert.equal(encoded.body, original, "the original bytes travel, untouched");
});

test("model weights are recognised by name as well", () => {
  for (const name of ["qwen.Q4_K_M.gguf", "net.onnx", "w.safetensors"]) {
    assert.equal(looksCompressed(name), true, name);
  }
});

test("still compresses something large that does compress", async () => {
  /* Sampling must not cost a real saving on a big log or a big JSON file. */
  const original = text(200_000);
  assert.ok(worthSampling(original.byteLength), "big enough to be sampled");
  const encoded = await encodeForUpload(original, "big.log", true);
  assert.equal(encoded.encoding, "gzip");
  assert.ok(encoded.body.byteLength < original.byteLength / 10);
});

test("a compressible head keeps a mixed file, rather than judging it on its tail", async () => {
  /*
    The risk sampling introduces. A file that starts with text and ends with
    noise compresses a little, and deciding on the first block must not throw
    that away — so the sample only abandons what did not compress at all.
  */
  const head = text(20_000);
  const original = new Uint8Array(head.byteLength + SAMPLE_BYTES * 16);
  original.set(head, 0);
  original.set(noise(SAMPLE_BYTES * 16), head.byteLength);
  const encoded = await encodeForUpload(original, "mixed.bin", true);
  assert.equal(encoded.encoding, "gzip");
});

test("a text manifest at the front does not commit an incompressible payload", async () => {
  /*
    The reverse shape, and the reason there are two windows. A container whose
    header compresses and whose payload does not would be deflated in full on
    the strength of its first block — spending the minutes this exists to save
    and then discarding the result. The middle window disagrees with the front.
  */
  const header = text(2_000);
  const original = new Uint8Array(SAMPLE_BYTES * 16);
  original.set(noise(original.byteLength), 0);
  original.set(header.subarray(0, SAMPLE_BYTES / 2), 0);
  const encoded = await encodeForUpload(original, "payload.unheardof", true);
  assert.equal(encoded.encoding, "identity");
});

test("looks at the front and the middle, so a header cannot speak for the file", () => {
  const windows = sampleWindows(SAMPLE_BYTES * 16);
  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.at, 0);
  assert.equal(windows[1]!.at, (SAMPLE_BYTES * 16) / 2);
});

test("does not sample something too small for sampling to save anything", () => {
  /* Two windows, so the piece has to be worth more than two windows of work. */
  assert.equal(worthSampling(SAMPLE_BYTES * 4), false);
  assert.equal(worthSampling(SAMPLE_BYTES * 8), true);
});

test("the sample judges by the threshold the final answer uses", () => {
  /*
    The first attempt at this asked only whether the sample compressed at all.
    A gguf chunk compresses by about 3%, so every window argued for a full
    deflate whose result was then discarded for saving 3% — the waste, intact.
    Estimating the real decision means using the real threshold.
  */
  assert.equal(sampleSaysDoNotBother(1000, 970), true, "3% is not worth it");
  assert.equal(sampleSaysDoNotBother(1000, 940), false, "6% is");
});

/*
  Giving up on a file, rather than on a piece of one.

  A 1 GB file is a thousand chunks, each compressed and judged alone, so no
  amount of care inside one chunk bounds the cost of the file. Thirteen `.gguf`
  weights totalling 10.6 GB went through deflate chunk by chunk for a 3% saving
  that was then discarded — 87% of everything the save did before sending a
  byte, spent twice because a save runs the pipeline twice.
*/

/** Feed the verdict a run of outcomes; returns how many were actually tried. */
const feed = (kept: boolean[]) => {
  const verdict = freshGzipVerdict();
  for (const one of kept) {
    if (!verdict.allowed) break;
    noteChunkOutcome(verdict, one);
  }
  return verdict;
};

test("gives up on a file whose chunks keep failing", () => {
  const verdict = feed(new Array(GZIP_REVIEW_EVERY * 4).fill(false));
  assert.equal(verdict.allowed, false);
  assert.equal(
    verdict.chunks,
    GZIP_REVIEW_EVERY,
    "stops at the first review, not after the whole file",
  );
});

test("never gives up on a file that does compress", () => {
  const verdict = feed(new Array(GZIP_REVIEW_EVERY * 10).fill(true));
  assert.equal(verdict.allowed, true);
});

test("a rate, not an existence — the bug the first attempt had", () => {
  /*
    Measured on a real 1 GB `.gguf`: 24 of 208 chunks cleared the 5% threshold
    and kept their compression, so "give up once nothing compressed" never
    fired. Those 24 chunks saved 0.7% of the file, for 87% of the save's time.
  */
  const oneInEight = Array.from(
    { length: GZIP_REVIEW_EVERY * 4 },
    (_unused, at) => at % 8 === 0,
  );
  assert.equal(feed(oneInEight).allowed, false, "one in eight is not worth it");
  const oneInThree = Array.from(
    { length: GZIP_REVIEW_EVERY * 4 },
    (_unused, at) => at % 3 === 0,
  );
  assert.equal(feed(oneInThree).allowed, true, "one in three is");
});

test("a compressible opening cannot buy an incompressible tail", () => {
  /*
    Why each window is judged on itself. Counted cumulatively, a long run that
    compressed would carry a far longer run that did not — sixteen good chunks
    buying sixty-four bad ones, and two hundred buying a thousand. That is the
    cost this exists to bound, reappearing in the guard meant to bound it.
  */
  for (const prefix of [GZIP_REVIEW_EVERY, GZIP_REVIEW_EVERY * 16]) {
    const verdict = feed([
      ...new Array(prefix).fill(true),
      ...new Array(GZIP_REVIEW_EVERY * 8).fill(false),
    ]);
    assert.equal(verdict.allowed, false);
    assert.equal(
      verdict.chunks,
      prefix + GZIP_REVIEW_EVERY,
      "one window of waste after it turns, however long the good run was",
    );
  }
});

test("records nothing once it has given up", () => {
  /* Otherwise a later run of successes would resurrect a settled decision. */
  const verdict = feed(new Array(GZIP_REVIEW_EVERY).fill(false));
  const settled = verdict.chunks;
  noteChunkOutcome(verdict, true);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.chunks, settled);
});
