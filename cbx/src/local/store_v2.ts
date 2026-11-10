/**
 * How a cbx-local 2 history keeps objects on disk (engine/V2-STORE.md).
 *
 * A v2 history holds exactly the objects a v1 history holds, under the same
 * names; only the way each is kept changes. A v2 pack is a run of records,
 * each one of:
 *
 *   whole    the object's bytes, as they are or zstd-compressed
 *   solid    many small objects joined and compressed as one block, so what
 *            files share (licence headers, imports, near-copies) is stored once
 *   delta    an exact COPY/INSERT patch (CRP2, the format the service applies)
 *            against another object, as it is or zstd-compressed
 *
 * Every object read is rebuilt and checked against its name before it is
 * used, delta bases included, so damage anywhere is refused rather than
 * passed on.
 *
 *   .cbx/objects/v2/<id>.pack   records, written whole then renamed
 *   .cbx/objects/v2/<id>.idx    binary index, sorted by name with a fan-out
 */
import { createHash } from "node:crypto";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const KIND_WHOLE = 1;
export const KIND_WHOLE_ZSTD = 2;
export const KIND_SOLID = 3;
export const KIND_DELTA = 4;
export const KIND_DELTA_ZSTD = 5;

/** Objects at most this big wait to be joined into a solid block. */
export const SOLID_OBJECT_LIMIT = 256 * 1024;
/** A solid block of small objects holds this much before it is compressed. */
export const SOLID_BLOCK_BYTES = 16 * 1024 * 1024;
/*
  Larger objects that compress are joined too, in bigger blocks with a window
  as big as the block, so one program can be kept as what it shares with
  another: CMake's fourteen largest files took 31.96 MB compressed one by one
  and 23.89 MB together. Git finds the same thing with its deltas after gc.
*/
export const LARGE_BLOCK_BYTES = 64 * 1024 * 1024;
export const LARGE_WINDOW_LOG = 26;
/** A delta may stand on at most this many others; past that the object is kept whole. */
export const MAX_CHAIN = 12;
/** A pack is written once the objects waiting for it reach this much. */
export const V2_PACK_BYTES = 128 * 1024 * 1024;

export type V2Entry = {
  kind: number;
  /** How many deltas stand under this one: 0 for a whole or solid object. */
  chain: number;
  /** Where the record is in the pack, and how long. */
  offset: number;
  length: number;
  /** Where the object starts inside a solid block's bytes. */
  inner: number;
  /** The object's own length. */
  raw: number;
  /** The object a delta is rebuilt from. */
  base?: string;
};

export function zstdAt(raw: Buffer, level: number, long = false, windowLog?: number, checksum = false): Buffer {
  return zstdCompressSync(raw, {
    params: {
      [constants.ZSTD_c_compressionLevel]: level,
      ...(long ? { [constants.ZSTD_c_enableLongDistanceMatching]: 1 } : {}),
      ...(windowLog ? { [constants.ZSTD_c_windowLog]: windowLog } : {}),
      /*
        Blocks carry zstd's own checksum: four bytes, and damage to a block is
        refused as damage even where it happens not to change the bytes. The
        digest of every object read is checked either way.
      */
      ...(checksum ? { [constants.ZSTD_c_checksumFlag]: 1 } : {}),
    },
  });
}

/** Whether bytes are worth compressing, judged from a 64 KiB sample of their middle. */
export function compresses(raw: Buffer): boolean {
  const sample = raw.length > 131072 ? raw.subarray((raw.length >> 1) - 32768, (raw.length >> 1) + 32768) : raw;
  return zstdAt(sample, 1).length < sample.length * 0.92;
}

export function unzstd(stored: Buffer): Buffer {
  return zstdDecompressSync(stored);
}

const INDEX_MAGIC = Buffer.from("CBXI", "latin1");
const INDEX_VERSION = 2;
const ENTRY_BYTES = 32 + 1 + 1 + 4 + 4 + 4 + 4;
const FANOUT = 256;
/* Below this many entries the fan-out table costs more than it saves, and is left out. */
const FANOUT_FROM = 1024;
const FLAG_FANOUT = 1;

/**
 * The index of one v2 pack: a 16-byte header, a 256-entry fan-out by first
 * byte (as Git's pack index has) when there are enough entries to need one,
 * fixed 50-byte entries sorted by name, and the names delta bases refer to,
 * once each. A delta's `inner` field is the position of its base in that
 * table.
 */
export function encodeIndex(entries: Map<string, V2Entry>): Buffer {
  const names = [...entries.keys()].sort();
  const bases: string[] = [];
  const baseAt = new Map<string, number>();
  for (const name of names) {
    const base = entries.get(name)!.base;
    if (base && !baseAt.has(base)) {
      baseAt.set(base, bases.length);
      bases.push(base);
    }
  }
  const fanout = names.length >= FANOUT_FROM;
  const entriesAt = 16 + (fanout ? FANOUT * 4 : 0);
  const out = Buffer.alloc(entriesAt + names.length * ENTRY_BYTES + bases.length * 32);
  INDEX_MAGIC.copy(out, 0);
  out.writeUInt8(INDEX_VERSION, 4);
  out.writeUInt8(fanout ? FLAG_FANOUT : 0, 5);
  out.writeUInt32LE(names.length, 8);
  out.writeUInt32LE(bases.length, 12);
  if (fanout) {
    const counts = new Array<number>(FANOUT).fill(0);
    for (const name of names) counts[Number.parseInt(name.slice(0, 2), 16)]! += 1;
    let running = 0;
    for (let byte = 0; byte < FANOUT; byte += 1) {
      running += counts[byte]!;
      out.writeUInt32LE(running, 16 + byte * 4);
    }
  }
  let at = entriesAt;
  for (const name of names) {
    const entry = entries.get(name)!;
    Buffer.from(name, "hex").copy(out, at);
    out.writeUInt8(entry.kind, at + 32);
    out.writeUInt8(entry.chain, at + 33);
    out.writeUInt32LE(entry.offset, at + 34);
    out.writeUInt32LE(entry.length, at + 38);
    out.writeUInt32LE(entry.base ? baseAt.get(entry.base)! : entry.inner, at + 42);
    out.writeUInt32LE(entry.raw, at + 46);
    at += ENTRY_BYTES;
  }
  for (const base of bases) {
    Buffer.from(base, "hex").copy(out, at);
    at += 32;
  }
  return out;
}

export function decodeIndex(bytes: Buffer): Map<string, V2Entry> {
  if (bytes.length < 16 || !bytes.subarray(0, 4).equals(INDEX_MAGIC)) {
    throw new Error("A v2 pack index is damaged");
  }
  if (bytes.readUInt8(4) !== INDEX_VERSION) throw new Error("A v2 pack index is of a version this cbx does not read");
  const count = bytes.readUInt32LE(8);
  const baseCount = bytes.readUInt32LE(12);
  const entriesAt = 16 + ((bytes.readUInt8(5) & FLAG_FANOUT) !== 0 ? FANOUT * 4 : 0);
  const basesAt = entriesAt + count * ENTRY_BYTES;
  if (bytes.length !== basesAt + baseCount * 32) throw new Error("A v2 pack index is damaged");
  const bases: string[] = [];
  for (let index = 0; index < baseCount; index += 1) {
    bases.push(bytes.subarray(basesAt + index * 32, basesAt + index * 32 + 32).toString("hex"));
  }
  const entries = new Map<string, V2Entry>();
  for (let index = 0; index < count; index += 1) {
    const at = entriesAt + index * ENTRY_BYTES;
    const kind = bytes.readUInt8(at + 32);
    const inner = bytes.readUInt32LE(at + 42);
    const delta = kind === KIND_DELTA || kind === KIND_DELTA_ZSTD;
    if (delta && inner >= baseCount) throw new Error("A v2 pack index is damaged");
    entries.set(bytes.subarray(at, at + 32).toString("hex"), {
      kind,
      chain: bytes.readUInt8(at + 33),
      offset: bytes.readUInt32LE(at + 34),
      length: bytes.readUInt32LE(at + 38),
      inner: delta ? 0 : inner,
      raw: bytes.readUInt32LE(at + 46),
      ...(delta ? { base: bases[inner]! } : {}),
    });
  }
  return entries;
}

/**
 * The order small objects are joined in: by extension, then name, so files
 * of one kind sit together where the compressor can see what they share.
 */
export function solidKey(filePath: string | undefined): string {
  if (!filePath) return "\u{10ffff}";
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return `${extension}\u0000${name.toLowerCase()}\u0000${filePath}`;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * One v2 index, searched where it lies rather than decoded whole: its
 * entries are sorted by name, so finding one is a binary search over the
 * bytes. A status needs a handful of objects, and decoding every entry of
 * every index into a map of strings was its largest single cost in a v2
 * history (15 ms of 270 for 8,500 files).
 */
export class V2IndexFile {
  readonly pack: string;
  readonly count: number;
  private readonly bytes: Buffer;
  private readonly entriesAt: number;
  private readonly basesAt: number;
  private readonly fanout: boolean;
  private readonly baseCount: number;

  constructor(pack: string, bytes: Buffer) {
    if (bytes.length < 16 || !bytes.subarray(0, 4).equals(INDEX_MAGIC)) {
      throw new Error("A v2 pack index is damaged");
    }
    if (bytes.readUInt8(4) !== INDEX_VERSION) throw new Error("A v2 pack index is of a version this cbx does not read");
    this.pack = pack;
    this.bytes = bytes;
    this.count = bytes.readUInt32LE(8);
    this.baseCount = bytes.readUInt32LE(12);
    this.fanout = (bytes.readUInt8(5) & FLAG_FANOUT) !== 0;
    this.entriesAt = 16 + (this.fanout ? FANOUT * 4 : 0);
    this.basesAt = this.entriesAt + this.count * ENTRY_BYTES;
    if (bytes.length !== this.basesAt + this.baseCount * 32) throw new Error("A v2 pack index is damaged");
  }

  find(digest: string): V2Entry | undefined {
    const key = Buffer.from(digest, "hex");
    if (key.length !== 32) return undefined;
    let low = 0;
    let high = this.count;
    if (this.fanout) {
      const first = key[0]!;
      low = first === 0 ? 0 : this.bytes.readUInt32LE(16 + (first - 1) * 4);
      high = this.bytes.readUInt32LE(16 + first * 4);
    }
    while (low < high) {
      const middle = (low + high) >> 1;
      const at = this.entriesAt + middle * ENTRY_BYTES;
      const order = key.compare(this.bytes, at, at + 32);
      if (order === 0) return this.entryAt(at);
      if (order < 0) high = middle;
      else low = middle + 1;
    }
    return undefined;
  }

  private entryAt(at: number): V2Entry {
    const kind = this.bytes.readUInt8(at + 32);
    const inner = this.bytes.readUInt32LE(at + 42);
    const delta = kind === KIND_DELTA || kind === KIND_DELTA_ZSTD;
    if (delta && inner >= this.baseCount) throw new Error("A v2 pack index is damaged");
    return {
      kind,
      chain: this.bytes.readUInt8(at + 33),
      offset: this.bytes.readUInt32LE(at + 34),
      length: this.bytes.readUInt32LE(at + 38),
      inner: delta ? 0 : inner,
      raw: this.bytes.readUInt32LE(at + 46),
      ...(delta
        ? { base: this.bytes.subarray(this.basesAt + inner * 32, this.basesAt + inner * 32 + 32).toString("hex") }
        : {}),
    };
  }

  *names(): Generator<string> {
    for (let index = 0; index < this.count; index += 1) {
      const at = this.entriesAt + index * ENTRY_BYTES;
      yield this.bytes.subarray(at, at + 32).toString("hex");
    }
  }
}
