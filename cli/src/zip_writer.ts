/**
 * Write a folder as a zip, one file at a time, to disk.
 *
 * Mod repositories take each part as a zip, and a game's mod can hold
 * hundreds of thousands of files and run to gigabytes — ZT1's art packs do —
 * so the archive is written as it goes rather than built in memory, and
 * ZIP64 records are used once sizes, offsets or the file count pass what the
 * classic format can hold. Each file is deflated, or stored when deflating
 * would not make it smaller (already-compressed images and audio).
 */
import { createWriteStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

type Written = {
  name: Buffer;
  crc: number;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
};

function dosTime(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/** Every file under a folder, as zip paths with forward slashes, in a stable order. */
export async function listFiles(root: string, skip: (relative: string) => boolean = () => false): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(path.join(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (skip(relative)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  await walk("");
  return found;
}

/**
 * Zip these files (paths relative to root) into `out`. `extra` adds entries
 * written from memory — a generated manifest, for one.
 */
export async function writeZip(
  root: string,
  files: string[],
  out: string,
  extra: Array<{ path: string; bytes: Uint8Array }> = [],
  onProgress?: (done: number, total: number) => void,
): Promise<{ files: number; bytes: number }> {
  const stream = createWriteStream(out);
  let failed: Error | null = null;
  stream.on("error", (error) => {
    failed = error;
  });
  const write = async (chunk: Uint8Array) => {
    if (failed) throw failed;
    if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once("drain", resolve));
    if (failed) throw failed;
  };
  const written: Written[] = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  const extraNames = new Set(extra.map((one) => one.path));
  const sources: Array<{ path: string; load: () => Promise<Uint8Array> }> = [
    ...extra.map((one) => ({ path: one.path, load: async () => one.bytes })),
    ...files.filter((file) => !extraNames.has(file)).map((file) => ({ path: file, load: () => readFile(path.join(root, file)) })),
  ];

  for (const [index, source] of sources.entries()) {
    const raw = await source.load();
    const deflated = deflateRawSync(raw, { level: 6 });
    const store = deflated.length >= raw.length;
    const body = store ? raw : deflated;
    const name = Buffer.from(source.path, "utf8");
    const crc = crc32(raw);
    const zip64 = raw.length >= MAX32 || body.length >= MAX32;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6); /* UTF-8 names */
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? MAX32 : body.length, 18);
    local.writeUInt32LE(zip64 ? MAX32 : raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localExtra = zip64 ? zip64Extra([raw.length, body.length]) : Buffer.alloc(0);
    local.writeUInt16LE(localExtra.length, 28);
    await write(local);
    await write(name);
    if (localExtra.length) await write(localExtra);
    await write(body);
    written.push({ name, crc, method: store ? 0 : 8, compressed: body.length, size: raw.length, offset, time, date });
    offset += local.length + name.length + localExtra.length + body.length;
    onProgress?.(index + 1, sources.length);
  }

  const centralStart = offset;
  for (const entry of written) {
    const big = [entry.size >= MAX32, entry.compressed >= MAX32, entry.offset >= MAX32];
    const values = [
      ...(big[0] ? [entry.size] : []),
      ...(big[1] ? [entry.compressed] : []),
      ...(big[2] ? [entry.offset] : []),
    ];
    const extraField = values.length ? zip64Extra(values) : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(values.length ? 45 : 20, 4);
    central.writeUInt16LE(values.length ? 45 : 20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.time, 12);
    central.writeUInt16LE(entry.date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(big[1] ? MAX32 : entry.compressed, 20);
    central.writeUInt32LE(big[0] ? MAX32 : entry.size, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(extraField.length, 30);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38); /* a plain file, never a link */
    central.writeUInt32LE(big[2] ? MAX32 : entry.offset, 42);
    await write(central);
    await write(entry.name);
    if (extraField.length) await write(extraField);
    offset += central.length + entry.name.length + extraField.length;
  }
  const centralSize = offset - centralStart;
  const needs64 = written.length >= MAX16 || centralStart >= MAX32 || centralSize >= MAX32;
  if (needs64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(written.length), 24);
    record.writeBigUInt64LE(BigInt(written.length), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(centralStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    await write(record);
    await write(locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needs64 ? MAX16 : written.length, 8);
  end.writeUInt16LE(needs64 ? MAX16 : written.length, 10);
  end.writeUInt32LE(needs64 ? MAX32 : centralSize, 12);
  end.writeUInt32LE(needs64 ? MAX32 : centralStart, 16);
  await write(end);
  await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => (error ? reject(error) : resolve())));
  return { files: written.length, bytes: offset + (needs64 ? 76 : 0) + 22 };
}

function zip64Extra(values: number[]): Buffer {
  const field = Buffer.alloc(4 + values.length * 8);
  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => field.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return field;
}
