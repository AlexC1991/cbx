/**
 * The object store under `.cbx/objects`: everything a local history holds.
 *
 * Every object is named by the SHA-256 of its original bytes and kept as a
 * chunk frame (see `core/cbx.ts`), so it is compressed when that saves at
 * least two percent and verified whenever it is read. Pieces of files, the
 * trees that list them and the saves that name a tree are all objects; an
 * object never changes once written, which is what makes writing one safe to
 * repeat and a store safe to copy while nothing is saving.
 *
 *   .cbx/objects/ab/cdef…        one object on its own ("loose")
 *   .cbx/objects/packs/<id>.pack  many small objects, frame after frame
 *   .cbx/objects/packs/<id>.idx   where each of them starts, as JSON
 *
 * Small objects go into packs because a file per object is what made the
 * first save of twenty thousand small files take thirty-six seconds on
 * Windows, nearly all of it creating files. A pack is written whole and
 * renamed into place before its index is, so an index on disk always
 * describes a finished pack; a pack with no index is an interrupted write
 * and is never read.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { chunkFrame, openChunkFrame } from "../core/cbx.js";
import { applyDeltaPatch, createExactDeltaPatch } from "../shared/delta.js";
import {
  encodeIndex,
  KIND_DELTA,
  KIND_DELTA_ZSTD,
  KIND_SOLID,
  KIND_WHOLE,
  KIND_WHOLE_ZSTD,
  compresses,
  LARGE_BLOCK_BYTES,
  LARGE_WINDOW_LOG,
  MAX_CHAIN,
  SOLID_BLOCK_BYTES,
  SOLID_OBJECT_LIMIT,
  solidKey,
  unzstd,
  V2_PACK_BYTES,
  zstdAt,
  type V2Entry,
  V2IndexFile,
} from "./store_v2.js";

export const DIGEST = /^[0-9a-f]{64}$/;

/** Objects at most this big are packed rather than written on their own. */
export const PACKED_OBJECT_LIMIT = 256 * 1024;

/** A pack is written out once it holds this much. */
const PACK_BYTES = 32 * 1024 * 1024;

export function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Located = { pack: string; offset: number; length: number };

/* An object a v2 store is holding until its pack is written. */
type PendingV2 =
  | { solid: true; raw: Buffer; key: string; large: boolean }
  | { solid: false; raw: Buffer; record: Buffer; kind: number; chain: number; base?: string };

/*
  Every v2 index, searched in place. A lookup is a binary search per pack,
  newest first, which is nothing for the few a status makes; a save or a
  restore makes thousands, and once the searches would cost more than
  decoding everything once, everything is decoded into one map.
*/
class V2Packs {
  private readonly files: V2IndexFile[] = [];
  private map: Map<string, V2Entry & { pack: string }> | null = null;
  private searches = 0;

  add(file: V2IndexFile): void {
    this.files.push(file);
    if (this.map) for (const name of file.names()) this.map.set(name, { ...file.find(name)!, pack: file.pack });
  }

  get(digest: string): (V2Entry & { pack: string }) | undefined {
    if (this.map) return this.map.get(digest);
    this.searches += this.files.length;
    if (this.searches > 200_000) {
      this.map = new Map();
      for (const file of this.files) {
        for (const name of file.names()) this.map.set(name, { ...file.find(name)!, pack: file.pack });
      }
      return this.map.get(digest);
    }
    for (let index = this.files.length - 1; index >= 0; index -= 1) {
      const found = this.files[index]!.find(digest);
      if (found) return { ...found, pack: this.files[index]!.pack };
    }
    return undefined;
  }

  has(digest: string): boolean {
    return this.get(digest) !== undefined;
  }

  *keys(): Generator<string> {
    for (const file of this.files) yield* file.names();
  }
}

/*
  The largest object kept as a delta: the biggest piece any chunk profile
  cuts (32 MiB). The transport stops at 8 MiB, and using its limit here kept
  every edited piece of a large file whole again: JDK's 130 MB module image
  is cut into pieces of up to 16 MiB.
*/
const LOCAL_DELTA_MAX_BYTES = 32 * 1024 * 1024;

/* Solid blocks kept decompressed, so restoring the files of one block reads it once. */
const BLOCKS_KEPT_BYTES = 160 * 1024 * 1024;

export class ObjectStore {
  readonly directory: string;
  /* Fan-out folders already known to exist, so each is made once, not per object. */
  private readonly made = new Set<string>();
  /* Every packed object, once the indexes have been read. */
  private packed: Map<string, Located> | null = null;
  /* Small objects waiting to be written as one pack. */
  private pending = new Map<string, Buffer>();
  /* The batch being written right now, still readable while it is. */
  private writing = new Map<string, Buffer>();
  private pendingBytes = 0;
  private flushing: Promise<void> | null = null;
  /*
    Packs held open while an operation reads from them. Opening a pack for
    each object made restoring twenty thousand small files take three
    minutes. Closed by `release`, which every operation calls when it ends,
    because Windows will not delete a folder holding an open file.
  */
  private handles = new Map<string, Promise<FileHandle>>();
  /*
    A cbx-local 2 history (store_v2.ts): the same objects, kept as solid
    blocks and deltas in v2 packs. A v1 history never writes them, but every
    store reads both, so upgrading changes nothing already written.
  */
  readonly v2: boolean;
  private v2Located: V2Packs | null = null;
  private pendingV2 = new Map<string, PendingV2>();
  private writingV2 = new Map<string, PendingV2>();
  private pendingV2Bytes = 0;
  private blocks = new Map<string, Buffer>();

  constructor(directory: string, options: { v2?: boolean } = {}) {
    this.directory = directory;
    this.v2 = options.v2 === true;
  }

  private get packDirectory(): string {
    return path.join(this.directory, "packs");
  }

  where(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error(`Not an object name: ${digest}`);
    return path.join(this.directory, digest.slice(0, 2), digest.slice(2));
  }

  /*
    Read once, by one caller: the lanes of a save ask at the same moment, and
    a second caller that found the v1 list set while the v2 list was still
    loading went on with no v2 list at all.
  */
  private loadingPacks: Promise<Map<string, Located>> | null = null;

  private async packs(): Promise<Map<string, Located>> {
    if (this.packed && this.v2Located) return this.packed;
    this.loadingPacks ??= this.loadPacks().finally(() => {
      this.loadingPacks = null;
    });
    return this.loadingPacks;
  }

  private async loadPacks(): Promise<Map<string, Located>> {
    const found = new Map<string, Located>();
    let names: string[] = [];
    try {
      names = await readdir(this.packDirectory);
    } catch {
      /* No packs yet. */
    }
    for (const name of names.filter((one) => one.endsWith(".idx")).sort()) {
      const pack = path.join(this.packDirectory, name.replace(/\.idx$/, ".pack"));
      const index = JSON.parse(
        await readFile(path.join(this.packDirectory, name), "utf8"),
      ) as Record<string, [number, number]>;
      for (const [digest, [offset, length]] of Object.entries(index)) {
        found.set(digest, { pack, offset, length });
      }
    }
    const v2 = await this.readV2Indexes();
    this.packed = found;
    this.v2Located = v2;
    return found;
  }

  private get v2Directory(): string {
    return path.join(this.directory, "v2");
  }

  private async readV2Indexes(): Promise<V2Packs> {
    const found = new V2Packs();
    let names: string[] = [];
    try {
      names = await readdir(this.v2Directory);
    } catch {
      /* No v2 packs. */
    }
    for (const name of names.filter((one) => one.endsWith(".idx")).sort()) {
      const pack = path.join(this.v2Directory, name.replace(/\.idx$/, ".pack"));
      found.add(new V2IndexFile(pack, await readFile(path.join(this.v2Directory, name))));
    }
    return found;
  }

  private async v2Index(): Promise<V2Packs> {
    await this.packs();
    return this.v2Located!;
  }

  private async loose(digest: string): Promise<boolean> {
    try {
      await stat(this.where(digest));
      return true;
    } catch {
      return false;
    }
  }

  async has(digest: string): Promise<boolean> {
    if (this.pending.has(digest) || this.writing.has(digest)) return true;
    if (this.pendingV2.has(digest) || this.writingV2.has(digest)) return true;
    if ((await this.packs()).has(digest)) return true;
    if (this.v2Located!.has(digest)) return true;
    return this.loose(digest);
  }

  /**
   * How many deltas stand under an object, or null when it is not held.
   * Anything kept whole, in a v1 store or loose, stands on nothing.
   */
  async chainOf(digest: string): Promise<number | null> {
    const waiting = this.pendingV2.get(digest) ?? this.writingV2.get(digest);
    if (waiting) return waiting.solid ? 0 : waiting.chain;
    const entry = (await this.v2Index()).get(digest);
    if (entry) return entry.chain;
    return (await this.has(digest)) ? 0 : null;
  }

  /** An object's own length without rebuilding it, or null when it is not held. */
  async rawSize(digest: string): Promise<number | null> {
    const waiting = this.pendingV2.get(digest) ?? this.writingV2.get(digest);
    if (waiting) return waiting.raw.length;
    const entry = (await this.v2Index()).get(digest);
    if (entry) return entry.raw;
    const frame = this.pending.get(digest) ?? this.writing.get(digest);
    if (frame) return Number(frame.readBigUInt64LE(8));
    const located = this.packed!.get(digest);
    try {
      const head = Buffer.alloc(16);
      if (located) {
        await (await this.handleFor(located.pack)).read(head, 0, 16, located.offset);
      } else {
        const handle = await open(this.where(digest), "r");
        try {
          await handle.read(head, 0, 16, 0);
        } finally {
          await handle.close();
        }
      }
      return Number(head.readBigUInt64LE(8));
    } catch {
      return null;
    }
  }

  /**
   * Keep `raw`, returning its name.
   *
   * A small object is held until there is a pack's worth, then written with
   * the others; call `flush` before anything else needs to read it from disk.
   * A large one is written beside its final name and renamed into place, so
   * an interrupted save never leaves half an object under a real name. An
   * object already present is not written again: same name, same bytes.
   */
  async put(
    raw: Buffer,
    options: {
      loose?: boolean;
      /*
        For a v2 store: an object these bytes probably resemble (the same
        file's last version), kept as a delta against when that is clearly
        smaller, and the path they belong to, which orders a solid block.
      */
      base?: string;
      path?: string;
      /* How many deltas may stand under this one; MAX_CHAIN unless said. */
      maxChain?: number;
    } = {},
  ): Promise<string> {
    const digest = digestOf(raw);
    if (await this.has(digest)) return digest;
    if (this.v2 && !options.loose) {
      await this.putV2(raw, digest, options.base, options.path, options.maxChain ?? MAX_CHAIN);
      return digest;
    }
    const { frame } = chunkFrame(raw);
    if (!options.loose && raw.length <= PACKED_OBJECT_LIMIT) {
      this.pending.set(digest, frame);
      this.pendingBytes += frame.length;
      if (this.pendingBytes >= PACK_BYTES) await this.flush();
      return digest;
    }
    const target = this.where(digest);
    const folder = path.dirname(target);
    if (!this.made.has(folder)) {
      await mkdir(folder, { recursive: true });
      this.made.add(folder);
    }
    const partial = `${target}.${randomBytes(6).toString("hex")}.partial`;
    await writeFile(partial, frame);
    try {
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      /* Another writer got there first with the same bytes. */
      if (!(await this.loose(digest))) throw error;
    }
    return digest;
  }

  /** Write whatever small objects are waiting as one pack. */
  async flush(): Promise<void> {
    /* One pack at a time; a second caller waits for the first and goes again. */
    while (this.flushing) await this.flushing;
    if (this.pendingV2.size) {
      const taken = this.pendingV2;
      this.pendingV2 = new Map();
      this.pendingV2Bytes = 0;
      this.writingV2 = taken;
      this.flushing = this.writeV2Pack(taken).finally(() => {
        this.writingV2 = new Map();
        this.flushing = null;
      });
      await this.flushing;
    }
    if (!this.pending.size) return;
    const taken = this.pending;
    this.pending = new Map();
    this.pendingBytes = 0;
    this.writing = taken;
    this.flushing = this.writePack(taken).finally(() => {
      this.writing = new Map();
      this.flushing = null;
    });
    await this.flushing;
  }

  /**
   * Keep one object in a v2 store: as a delta against `base` when that is
   * clearly smaller than the object compressed on its own and the base does
   * not already stand on too many others; otherwise joined into a solid
   * block when small, or whole.
   */
  private async putV2(
    raw: Buffer,
    digest: string,
    base: string | undefined,
    filePath: string | undefined,
    maxChain: number,
  ): Promise<void> {
    if (base && base !== digest && raw.length >= 64 && raw.length <= LOCAL_DELTA_MAX_BYTES) {
      const depth = await this.chainOf(base);
      if (depth !== null && depth + 1 < Math.min(maxChain, MAX_CHAIN) + 1) {
        let from: Buffer | null = null;
        try {
          from = await this.get(base);
        } catch {
          from = null;
        }
        if (from && from.length <= LOCAL_DELTA_MAX_BYTES) {
          const patch = Buffer.from(createExactDeltaPatch(from, raw, LOCAL_DELTA_MAX_BYTES));
          const squeezed = patch.length > 64 ? zstdAt(patch, 3) : patch;
          const packed = squeezed.length < patch.length;
          const record = packed ? squeezed : patch;
          /* Against what the object costs compressed on its own, not its raw size. */
          const alone = Math.min(raw.length, zstdAt(raw, 1).length);
          if (record.length < alone / 2 && alone - record.length >= 96) {
            await this.holdV2(digest, {
              solid: false,
              raw,
              record,
              kind: packed ? KIND_DELTA_ZSTD : KIND_DELTA,
              chain: depth + 1,
              base,
            });
            return;
          }
        }
      }
    }
    if (raw.length <= SOLID_OBJECT_LIMIT) {
      await this.holdV2(digest, { solid: true, raw, key: solidKey(filePath), large: false });
      return;
    }
    /* Larger and compressible: joined with others of its kind. Otherwise kept as it is. */
    if (compresses(raw)) {
      await this.holdV2(digest, { solid: true, raw, key: solidKey(filePath), large: true });
      return;
    }
    await this.holdV2(digest, { solid: false, raw, record: raw, kind: KIND_WHOLE, chain: 0 });
  }

  private async holdV2(digest: string, held: PendingV2): Promise<void> {
    this.pendingV2.set(digest, held);
    this.pendingV2Bytes += held.raw.length;
    /* Written when there is a pack's worth; callers flush at the end of a save either way. */
    if (this.pendingV2Bytes >= V2_PACK_BYTES) await this.flush();
  }

  private async writeV2Pack(objects: Map<string, PendingV2>): Promise<void> {
    await mkdir(this.v2Directory, { recursive: true });
    const entries = new Map<string, V2Entry>();
    const records: Buffer[] = [];
    let offset = 0;
    const solid = [...objects]
      .filter((pair): pair is [string, Extract<PendingV2, { solid: true }>] => pair[1].solid)
      .sort(([leftName, left], [rightName, right]) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : leftName < rightName ? -1 : 1,
      );
    let block: Array<[string, Buffer]> = [];
    let blockBytes = 0;
    let blockLarge = false;
    const closeBlock = () => {
      if (!block.length) return;
      const joined = Buffer.concat(block.map(([, raw]) => raw));
      const stored = zstdAt(joined, 9, true, blockLarge ? LARGE_WINDOW_LOG : undefined, true);
      let inner = 0;
      for (const [digest, raw] of block) {
        entries.set(digest, { kind: KIND_SOLID, chain: 0, offset, length: stored.length, inner, raw: raw.length });
        inner += raw.length;
      }
      records.push(stored);
      offset += stored.length;
      block = [];
      blockBytes = 0;
    };
    /* Small objects first, then large: the two tiers never share a block. */
    for (const large of [false, true]) {
      const limit = large ? LARGE_BLOCK_BYTES : SOLID_BLOCK_BYTES;
      blockLarge = large;
      for (const [digest, held] of solid) {
        if (held.large !== large) continue;
        if (blockBytes && blockBytes + held.raw.length > limit) closeBlock();
        block.push([digest, held.raw]);
        blockBytes += held.raw.length;
      }
      closeBlock();
    }
    for (const [digest, held] of objects) {
      if (held.solid) continue;
      entries.set(digest, {
        kind: held.kind,
        chain: held.chain,
        offset,
        length: held.record.length,
        inner: 0,
        raw: held.raw.length,
        ...(held.base ? { base: held.base } : {}),
      });
      records.push(held.record);
      offset += held.record.length;
    }
    const body = Buffer.concat(records);
    const id = digestOf(body);
    const pack = path.join(this.v2Directory, `${id}.pack`);
    const idx = path.join(this.v2Directory, `${id}.idx`);
    await writeFile(`${pack}.partial`, body);
    await rename(`${pack}.partial`, pack);
    const encoded = encodeIndex(entries);
    await writeFile(`${idx}.partial`, encoded);
    await rename(`${idx}.partial`, idx);
    (await this.v2Index()).add(new V2IndexFile(pack, encoded));
  }

  private handleFor(pack: string): Promise<FileHandle> {
    let opening = this.handles.get(pack);
    if (!opening) {
      opening = open(pack, "r");
      this.handles.set(pack, opening);
    }
    return opening;
  }

  private async readRecord(entry: { pack: string; offset: number; length: number }): Promise<Buffer> {
    const record = Buffer.alloc(entry.length);
    const { bytesRead } = await (await this.handleFor(entry.pack)).read(record, 0, entry.length, entry.offset);
    if (bytesRead !== entry.length) throw new Error("A v2 pack ends before one of its records does");
    return record;
  }

  /** Rebuild one object from a v2 pack and check it against its name. */
  private async getV2(digest: string, entry: V2Entry & { pack: string }): Promise<Buffer> {
    let raw: Buffer;
    try {
      if (entry.kind === KIND_SOLID) {
        const key = `${entry.pack}:${entry.offset}`;
        let block = this.blocks.get(key);
        if (block) {
          this.blocks.delete(key);
        } else {
          block = unzstd(await this.readRecord(entry));
        }
        this.blocks.set(key, block);
        let kept = 0;
        for (const one of this.blocks.values()) kept += one.length;
        while (kept > BLOCKS_KEPT_BYTES && this.blocks.size > 1) {
          const oldest = this.blocks.keys().next().value!;
          kept -= this.blocks.get(oldest)!.length;
          this.blocks.delete(oldest);
        }
        if (entry.inner + entry.raw > block.length) throw new Error("it reaches outside its block");
        raw = Buffer.from(block.subarray(entry.inner, entry.inner + entry.raw));
      } else if (entry.kind === KIND_WHOLE || entry.kind === KIND_WHOLE_ZSTD) {
        const record = await this.readRecord(entry);
        raw = entry.kind === KIND_WHOLE ? record : unzstd(record);
      } else if (entry.kind === KIND_DELTA || entry.kind === KIND_DELTA_ZSTD) {
        const record = await this.readRecord(entry);
        const patch = entry.kind === KIND_DELTA ? record : unzstd(record);
        raw = Buffer.from(applyDeltaPatch(await this.get(entry.base!), patch, LOCAL_DELTA_MAX_BYTES));
      } else {
        throw new Error("it is of a kind this cbx does not read");
      }
    } catch (error) {
      throw new Error(
        `Object ${digest.slice(0, 12)} could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (digestOf(raw) !== digest) {
      throw new Error(`Object ${digest.slice(0, 12)} is damaged: its bytes do not match its name`);
    }
    return raw;
  }

  private async writePack(objects: Map<string, Buffer>): Promise<void> {
    await mkdir(this.packDirectory, { recursive: true });
    const index: Record<string, [number, number]> = {};
    const frames: Buffer[] = [];
    let offset = 0;
    for (const [digest, frame] of [...objects].sort(([left], [right]) => (left < right ? -1 : 1))) {
      index[digest] = [offset, frame.length];
      frames.push(frame);
      offset += frame.length;
    }
    const body = Buffer.concat(frames);
    const id = digestOf(body);
    const pack = path.join(this.packDirectory, `${id}.pack`);
    const idx = path.join(this.packDirectory, `${id}.idx`);
    await writeFile(`${pack}.partial`, body);
    await rename(`${pack}.partial`, pack);
    await writeFile(`${idx}.partial`, JSON.stringify(index));
    await rename(`${idx}.partial`, idx);
    const known = await this.packs();
    for (const [digest, [at, length]] of Object.entries(index)) {
      known.set(digest, { pack, offset: at, length });
    }
  }

  async get(digest: string): Promise<Buffer> {
    const waiting = this.pending.get(digest) ?? this.writing.get(digest);
    if (waiting) return openChunkFrame(waiting, digest);
    const held = this.pendingV2.get(digest) ?? this.writingV2.get(digest);
    if (held) return Buffer.from(held.raw);
    const located = (await this.packs()).get(digest);
    const inV2 = !located ? this.v2Located!.get(digest) : undefined;
    if (inV2) return this.getV2(digest, inV2);
    if (located) {
      const handle = await this.handleFor(located.pack);
      const frame = Buffer.alloc(located.length);
      const { bytesRead } = await handle.read(frame, 0, located.length, located.offset);
      if (bytesRead !== located.length) {
        throw new Error(`Object ${digest.slice(0, 12)} runs past the end of its pack`);
      }
      return openChunkFrame(frame, digest);
    }
    let frame: Buffer;
    try {
      frame = await readFile(this.where(digest));
    } catch {
      throw new Error(`The history is missing object ${digest.slice(0, 12)}`);
    }
    return openChunkFrame(frame, digest);
  }

  /**
   * Read the pack indexes again on next use.
   *
   * For after something else has written packs into this store — the native
   * engine does, during a save — since the list is read once and then kept.
   */
  rescan(): void {
    this.packed = null;
    this.v2Located = null;
  }

  /** Close any packs held open for reading. Safe to call at any time. */
  async release(): Promise<void> {
    const open = [...this.handles.values()];
    this.handles.clear();
    for (const opening of open) {
      try {
        await (await opening).close();
      } catch {
        /* Never opened, or already closed. */
      }
    }
  }

  /** Stored on its own, so a save or tree is one file a person can find. */
  async putJson(value: unknown): Promise<string> {
    return this.put(Buffer.from(JSON.stringify(value), "utf8"), { loose: true });
  }

  async getJson<T>(digest: string): Promise<T> {
    /*
      Saves and trees are written on their own (putJson), so they are looked
      for there first. Going through get() read every pack's index just to
      find them, which grew with the history: the same object either way,
      checked the same way.
    */
    if (!this.pending.has(digest) && !this.writing.has(digest) && !this.pendingV2.has(digest) && !this.writingV2.has(digest)) {
      let frame: Buffer | null = null;
      try {
        frame = await readFile(this.where(digest));
      } catch {
        /* Not on its own; packed, perhaps. */
      }
      if (frame) return JSON.parse(openChunkFrame(frame, digest).toString("utf8")) as T;
    }
    return JSON.parse((await this.get(digest)).toString("utf8")) as T;
  }

  /** Every object whose name starts with `prefix` (at least four characters). */
  async matching(prefix: string): Promise<string[]> {
    if (!/^[0-9a-f]{4,64}$/.test(prefix)) return [];
    const found = new Set<string>();
    try {
      const rest = prefix.slice(2);
      for (const name of await readdir(path.join(this.directory, prefix.slice(0, 2)))) {
        if (name.length === 62 && name.startsWith(rest)) found.add(prefix.slice(0, 2) + name);
      }
    } catch {
      /* No loose objects under that prefix. */
    }
    for (const digest of (await this.packs()).keys()) {
      if (digest.startsWith(prefix)) found.add(digest);
    }
    for (const digest of this.v2Located!.keys()) {
      if (digest.startsWith(prefix)) found.add(digest);
    }
    return [...found];
  }
}
