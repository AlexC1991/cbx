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

export const DIGEST = /^[0-9a-f]{64}$/;

/** Objects at most this big are packed rather than written on their own. */
export const PACKED_OBJECT_LIMIT = 256 * 1024;

/** A pack is written out once it holds this much. */
const PACK_BYTES = 32 * 1024 * 1024;

export function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Located = { pack: string; offset: number; length: number };

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

  constructor(directory: string) {
    this.directory = directory;
  }

  private get packDirectory(): string {
    return path.join(this.directory, "packs");
  }

  where(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error(`Not an object name: ${digest}`);
    return path.join(this.directory, digest.slice(0, 2), digest.slice(2));
  }

  private async packs(): Promise<Map<string, Located>> {
    if (this.packed) return this.packed;
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
    this.packed = found;
    return found;
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
    if ((await this.packs()).has(digest)) return true;
    return this.loose(digest);
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
  async put(raw: Buffer, options: { loose?: boolean } = {}): Promise<string> {
    const digest = digestOf(raw);
    if (await this.has(digest)) return digest;
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
    const located = (await this.packs()).get(digest);
    if (located) {
      let opening = this.handles.get(located.pack);
      if (!opening) {
        opening = open(located.pack, "r");
        this.handles.set(located.pack, opening);
      }
      const handle = await opening;
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
    return [...found];
  }
}
