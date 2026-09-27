import assert from "node:assert/strict";
import test from "node:test";

import { cutPoints } from "../dist/core/cbx.js";

/**
 * Cutting a file into the pieces that are sent.
 *
 * `cutPoints` answers a narrower question than its name suggests: it returns
 * the boundaries *inside* a buffer and never its end. The packer in cbx.ts has
 * always known that — it emits whatever is left after its loop — but the
 * uploader was written to read the list literally, which dropped the bytes
 * after the last cut and truncated every chunked file by exactly the length of
 * its final piece.
 *
 * It was caught by the service refusing a version whose chunks did not add up
 * to its file, which is the check that exists for precisely this. These make
 * sure it is caught here instead, where it is cheap.
 */

/** The boundary list an uploader must actually send, tail included. */
function boundaries(body: Buffer): number[] {
  const bounds = [...cutPoints(body)];
  if (bounds[bounds.length - 1] !== body.length) bounds.push(body.length);
  return bounds;
}

/** Compressible, varied content — random bytes would not cut realistically. */
function sample(size: number, salt = ""): Buffer {
  const body = Buffer.alloc(size);
  for (let at = 0; at < size; at += 64) {
    body.write(`line ${at}${salt} the quick brown fox jumps over a dog\n`, at);
  }
  return body;
}

test("the raw cut points do not reach the end of the buffer", () => {
  /*
    Documenting the sharp edge rather than assuming it. If this ever stops
    being true the guard below becomes a no-op, and a silent one.
  */
  const body = sample(48 * 1024 * 1024);
  const cuts = cutPoints(body);
  assert.ok(cuts.length > 0, "expected the sample to be cut at all");
  assert.notEqual(cuts[cuts.length - 1], body.length);
});

test("the boundaries an upload uses cover every byte", () => {
  const body = sample(48 * 1024 * 1024);
  const bounds = boundaries(body);
  let offset = 0;
  let covered = 0;
  for (const end of bounds) {
    covered += end - offset;
    offset = end;
  }
  assert.equal(covered, body.length);
  assert.equal(bounds[bounds.length - 1], body.length);
});

test("the pieces concatenate back into the original", () => {
  /*
    The property the service checks and the download depends on. Order and
    completeness in one assertion: anything dropped, duplicated or reordered
    fails here.
  */
  const body = sample(20 * 1024 * 1024);
  const pieces: Buffer[] = [];
  let offset = 0;
  for (const end of boundaries(body)) {
    pieces.push(body.subarray(offset, end));
    offset = end;
  }
  assert.ok(Buffer.concat(pieces).equals(body));
});

test("a file smaller than one chunk is still one whole piece", () => {
  const body = sample(64 * 1024);
  const bounds = boundaries(body);
  assert.deepEqual(bounds, [body.length]);
});

test("an edit in the middle leaves most boundaries alone", () => {
  /*
    The reason for content-defined chunking at all. Boundaries follow the
    bytes, so changing the middle of a file shifts the chunk around the edit
    and leaves the rest where they were — which is what makes the unchanged
    parts free on the next save.
  */
  const original = sample(48 * 1024 * 1024);
  const edited = Buffer.from(original);
  edited.write("EDITED HERE", Math.floor(original.length / 2));

  const before = new Set(boundaries(original));
  const after = boundaries(edited);
  const shared = after.filter((cut) => before.has(cut)).length;
  assert.ok(
    shared >= after.length - 2,
    `expected nearly every boundary to survive, kept ${shared} of ${after.length}`,
  );
});
