import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cutPoints } from "../dist/core/cbx.js";

/**
 * Cutting a large file without holding it.
 *
 * The uploader used to read a file whole in order to chunk it, which for
 * everything on that path — sixteen megabytes and up — meant an allocation the
 * size of the file. A three gigabyte video was a three gigabyte buffer and an
 * out-of-memory crash partway through, which is the one failure worse than a
 * slow upload: it happens after the work rather than instead of it.
 *
 * These check the property that replaces it: the window in hand stays the same
 * size whatever the file is, and the pieces still reassemble exactly.
 */

/** The streaming cut, as the uploader performs it. */
async function streamPieces(
  file: string,
  onWindow: (bytes: number) => void,
): Promise<Buffer[]> {
  const pieces: Buffer[] = [];
  let pending = Buffer.alloc(0);
  for await (const block of createReadStream(file, {
    highWaterMark: 8 * 1024 * 1024,
  })) {
    const incoming = Buffer.from(block as Buffer);
    pending = pending.length ? Buffer.concat([pending, incoming]) : incoming;
    onWindow(pending.byteLength);
    let from = 0;
    for (const cut of cutPoints(pending)) {
      pieces.push(Buffer.from(pending.subarray(from, cut)));
      from = cut;
    }
    pending = Buffer.from(pending.subarray(from));
  }
  if (pending.length) pieces.push(pending);
  return pieces;
}

/** Compressible, varied content — random bytes cut unrealistically. */
function sample(size: number): Buffer {
  const body = Buffer.alloc(size);
  for (let at = 0; at < size; at += 64) {
    body.write(`line ${at} the quick brown fox jumps over the lazy dog\n`, at);
  }
  return body;
}

test("the pieces reassemble into the original file exactly", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "chunk-"));
  try {
    const original = sample(70 * 1024 * 1024);
    const file = path.join(folder, "big.bin");
    await writeFile(file, original);

    const pieces = await streamPieces(file, () => undefined);
    const rebuilt = Buffer.concat(pieces);
    /*
      Order and completeness in one assertion. A dropped tail, a duplicated
      window or a reordered piece all fail here — and all of them would produce
      a file that still looks plausible.
    */
    assert.equal(
      createHash("sha256").update(rebuilt).digest("hex"),
      createHash("sha256").update(original).digest("hex"),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("the window in hand does not grow with the file", async () => {
  /*
    The whole point. A larger file must not mean a larger buffer, or the crash
    this replaced simply moves further out.
  */
  const folder = await mkdtemp(path.join(tmpdir(), "chunk-"));
  try {
    const peaks: number[] = [];
    for (const size of [40, 120] as const) {
      const file = path.join(folder, `size${size}.bin`);
      await writeFile(file, sample(size * 1024 * 1024));
      let peak = 0;
      await streamPieces(file, (bytes) => {
        peak = Math.max(peak, bytes);
      });
      peaks.push(peak);
    }
    const [smaller, larger] = peaks;
    /*
      Tripling the file must not meaningfully move the high-water mark. The
      bound is one read plus one maximum chunk, which is the same for both.
    */
    assert.ok(
      larger <= smaller * 1.5,
      `window grew from ${smaller} to ${larger} bytes as the file tripled`,
    );
    assert.ok(
      larger < 64 * 1024 * 1024,
      `window reached ${larger} bytes, past one read plus one chunk`,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a file smaller than one read still produces its bytes", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "chunk-"));
  try {
    const original = sample(64 * 1024);
    const file = path.join(folder, "small.bin");
    await writeFile(file, original);
    const pieces = await streamPieces(file, () => undefined);
    /* One piece, because cutPoints finds no boundary inside it. */
    assert.equal(pieces.length, 1);
    assert.ok(Buffer.concat(pieces).equals(original));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
