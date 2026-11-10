/**
 * The zip `cbx mods publish` writes has to open anywhere: in the scanner's
 * Python zipfile, and in a game's own loader. Read back here by walking the
 * central directory the way any reader does, inflating each entry and
 * checking its CRC, and forced past 65,535 entries so the ZIP64 records are
 * exercised — ZT1's art packs hold hundreds of thousands of files.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

import { crc32, listFiles, writeZip } from "../dist/cli/src/zip_writer.js";

type Read = { name: string; bytes: Buffer; mode: number };

function readZip(zip: Buffer): Read[] {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endAt >= 0, "end of central directory");
  let count = zip.readUInt16LE(endAt + 10);
  let start = zip.readUInt32LE(endAt + 16);
  if (count === 0xffff || start === 0xffffffff) {
    const locator = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    const record = Number(zip.readBigUInt64LE(locator + 8));
    count = Number(zip.readBigUInt64LE(record + 32));
    start = Number(zip.readBigUInt64LE(record + 48));
  }
  const out: Read[] = [];
  let at = start;
  for (let n = 0; n < count; n += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = zip.readUInt16LE(offset + 26);
    const localExtra = zip.readUInt16LE(offset + 28);
    const body = zip.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + compressed);
    const bytes = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(bytes), crc, `${name} crc`);
    out.push({ name, bytes, mode });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

test("a folder zips with its manifest, readable, and never as links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-zip-"));
  try {
    await mkdir(path.join(root, "src", "hd"), { recursive: true });
    await writeFile(path.join(root, "src", "hd", "a.txt"), "hello ".repeat(500));
    await writeFile(path.join(root, "src", "hd", "b.png"), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) % 256)));
    await writeFile(path.join(root, "src", "Ünïcode.json"), "{}");
    await writeFile(path.join(root, "src", "mod.json"), "stale");
    const files = await listFiles(path.join(root, "src"));
    const result = await writeZip(path.join(root, "src"), files, path.join(root, "out.zip"), [
      { path: "mod.json", bytes: Buffer.from('{"id":"x"}') },
    ]);
    assert.equal(result.files, 4);
    const read = readZip(await readFile(path.join(root, "out.zip")));
    assert.deepEqual(read.map((r) => r.name).sort(), ["hd/a.txt", "hd/b.png", "mod.json", "Ünïcode.json"].sort());
    assert.equal(read.find((r) => r.name === "mod.json")!.bytes.toString(), '{"id":"x"}', "the written manifest wins over the folder's");
    assert.equal(read.find((r) => r.name === "hd/a.txt")!.bytes.toString(), "hello ".repeat(500));
    for (const entry of read) assert.equal(entry.mode & 0o170000, 0o100000, `${entry.name} is a plain file`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("more than 65,535 files switch to ZIP64 and still read back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-zip64-"));
  try {
    for (let d = 0; d < 66; d += 1) {
      await mkdir(path.join(root, "src", `d${d}`), { recursive: true });
      await Promise.all(Array.from({ length: 1000 }, (_, f) => writeFile(path.join(root, "src", `d${d}`, `f${f}`), `frame ${d}.${f}`)));
    }
    const files = await listFiles(path.join(root, "src"));
    assert.equal(files.length, 66000);
    await writeZip(path.join(root, "src"), files, path.join(root, "big.zip"));
    const read = readZip(await readFile(path.join(root, "big.zip")));
    assert.equal(read.length, 66000);
    assert.equal(read.find((r) => r.name === "d65/f999")!.bytes.toString(), "frame 65.999");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
