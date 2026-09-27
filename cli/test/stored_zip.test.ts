/**
 * Reading back exactly what the service writes.
 *
 * Checked against `backend/src/archive.ts` itself rather than a fixture made
 * to suit the reader, because the only archive this ever has to read is the
 * one that writer produces — and a fixture agrees with whatever assumption
 * built it. If the writer changes, this fails, which is the point.
 *
 * What it is guarding is a clone. The import fetched every blob in its own
 * request, so a 21,071-file project took four hours; the archive is one
 * request for the lot. A reader that silently mangled an entry would put
 * wrong bytes in somebody's checkout, which is far worse than a slow clone.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { readStoredZip } from "../src/stored_zip.ts";

/*
  The writer lives in the service, which is not part of the open-source
  checkout. There, the tests that need it are skipped and say why; in the
  full repository they run against the real thing, as they always have.
*/
const writerFile = new URL("../../backend/src/archive.ts", import.meta.url);
const writer = existsSync(writerFile) ? await import(writerFile.href) : null;
const withWriter = writer
  ? test
  : (name: string, _body: unknown) =>
      test(name, { skip: "the service's archive writer is not in this checkout" }, () => {});
const zipStream = (...args: unknown[]) => writer!.zipStream(...args);

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

/** Run the real writer and collect what it produces. */
async function archiveOf(
  files: Array<{ path: string; body: Uint8Array }>,
): Promise<Uint8Array> {
  const stream = zipStream(
    files.map((file) => ({
      path: file.path,
      size: file.body.length,
      read: async () => file.body,
    })),
  );
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  const total = parts.reduce((sum, one) => sum + one.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

withWriter("reads back every file the writer put in", async () => {
  const files = [
    { path: "README.md", body: bytes("# hello\n") },
    { path: "src/app.ts", body: bytes("export const a = 1;\n") },
    { path: "deep/er/still/note.txt", body: bytes("buried\n") },
  ];
  const entries = readStoredZip(await archiveOf(files));
  assert.deepEqual(
    entries.map((one) => one.path),
    files.map((one) => one.path),
    "paths, in the order they were written",
  );
  for (const [index, entry] of entries.entries()) {
    assert.equal(text(entry.bytes), text(files[index]!.body));
  }
});

withWriter("an empty file is an entry, not a gap", async () => {
  /* A zero-length entry has a header and no body; a reader that advanced by
     a body it did not check for would swallow the next header with it. */
  const entries = readStoredZip(
    await archiveOf([
      { path: "empty.txt", body: new Uint8Array(0) },
      { path: "after.txt", body: bytes("still here\n") },
    ]),
  );
  assert.deepEqual(entries.map((one) => one.path), ["empty.txt", "after.txt"]);
  assert.equal(entries[0]!.bytes.length, 0);
  assert.equal(text(entries[1]!.bytes), "still here\n");
});

withWriter("carries bytes that are not text", async () => {
  const raw = new Uint8Array([0, 1, 2, 250, 251, 252, 10, 13, 26, 0, 255]);
  const entries = readStoredZip(await archiveOf([{ path: "b.bin", body: raw }]));
  assert.deepEqual([...entries[0]!.bytes], [...raw]);
});

withWriter("keeps a name that is not ASCII", async () => {
  /* The writer sets the UTF-8 flag; a reader decoding as latin-1 would turn
     somebody's filename into mojibake and write it to disk that way. */
  const entries = readStoredZip(
    await archiveOf([{ path: "ré sumé/données.txt", body: bytes("ok") }]),
  );
  assert.equal(entries[0]!.path, "ré sumé/données.txt");
});

withWriter("an archive of nothing reads as nothing", async () => {
  assert.deepEqual(readStoredZip(await archiveOf([])), []);
});

test("refuses what it cannot read rather than guessing", () => {
  /*
    The caller falls back to fetching files one at a time, which is slow and
    correct. Carrying on through a record this does not understand would be
    fast and wrong.
  */
  assert.throws(() => readStoredZip(bytes("not an archive at all")));
  /* A truncated download: a header promising more than arrived. */
  const short = new Uint8Array(34);
  new DataView(short.buffer).setUint32(0, 0x04034b50, true);
  new DataView(short.buffer).setUint32(18, 9999, true);
  new DataView(short.buffer).setUint16(26, 1, true);
  assert.throws(() => readStoredZip(short), /ends inside an entry/);
});

withWriter("an archive cut off between two entries is refused, not taken as whole", async () => {
  /*
    The case that made a clone take half an hour. The service's archive of a
    9,010-file version ended after 4,978 entries — at an entry boundary, with
    every entry intact — and this read it as complete. The clone then fetched
    the other 4,032 one at a time and said nothing.
  */
  const whole = await archiveOf([
    { path: "a.txt", body: bytes("one\n") },
    { path: "b.txt", body: bytes("two\n") },
    { path: "c.txt", body: bytes("three\n") },
  ]);
  /* Cut just before the third entry's header: two whole entries, no directory. */
  const view = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
  let at = 0;
  for (let seen = 0; seen < 2; seen += 1) {
    const size = view.getUint32(at + 18, true);
    at += 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + size;
  }
  assert.throws(() => readStoredZip(whole.subarray(0, at)), /cut off after 2 entries/);
});

withWriter("a directory that counts differently from what was read is refused", async () => {
  const whole = await archiveOf([
    { path: "a.txt", body: bytes("one\n") },
    { path: "b.txt", body: bytes("two\n") },
  ]);
  const copy = whole.slice();
  const view = new DataView(copy.buffer);
  for (let at = copy.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      view.setUint16(at + 10, 3, true);
      break;
    }
  }
  assert.throws(() => readStoredZip(copy), /says it holds 3 entries and 2 were read/);
});
