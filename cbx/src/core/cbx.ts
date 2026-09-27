/**
 * The CodeBox `.cbx` bundle, as `prototype/cbx_benchmark.py` writes it.
 *
 * This is a port of that format, not a second one. The byte layout, the
 * manifest keys, the codec rule and the chunk index are taken from the
 * prototype so that an archive written here can be opened by
 * `codebox-compression.cmd unpack`, and an archive written by that tool can
 * be opened here — including format version 2 solid packs.
 *
 *   header       <4sHH16s>      CBX1, format version, flags, bundle id
 *   chunk frame  <4sB3xQQ32s32s> CHNK, codec, raw size, stored size, digests
 *   manifest     <4sQQ32s>      MANF, raw length, stored length, raw digest
 *   footer       <4sQQ32s>      CBXF, manifest offset, record length, digest
 *
 * Chunks are Zstandard level 3, stored raw unless compression saves at least
 * two percent, and identified by the SHA-256 of their original bytes.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open as openFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { inside } from "../shared/safe_path.js";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { underway } from "./download.js";
import {
  DEFAULT_CHUNK_PROFILE,
  cutPoints,
  manifestChunking,
} from "../shared/chunking.js";

export { cutPoints } from "../shared/chunking.js";

export const HEADER_MAGIC = "CBX1";
export const CHUNK_MAGIC = "CHNK";
export const MANIFEST_MAGIC = "MANF";
export const FOOTER_MAGIC = "CBXF";

const HEADER_BYTES = 24;
const CHUNK_HEADER_BYTES = 88;
const MANIFEST_HEADER_BYTES = 52;
const FOOTER_BYTES = 52;

/** The prototype writes 2 and accepts 1; without solid packs this is a 1. */
const WRITTEN_FORMAT_VERSION = 1;
const SUPPORTED_FORMAT_VERSIONS = new Set([1, 2]);

const CODEC_NONE = 0;
const CODEC_ZSTD = 1;

const ZSTD_LEVEL = 3;
const MIN_COMPRESSION_SAVING = 0.02;

const READ_SIZE = 8 * 1024 * 1024;

const zstd = (raw: Buffer): Buffer =>
  zstdCompressSync(raw, {
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export type ChunkRecord = {
  payload_offset: number;
  raw_size: number;
  stored_size: number;
  codec: number;
  stored_sha256: string;
};

export type FileRecord = {
  path: string;
  size: number;
  mtime_ns: number;
  mode: number;
  sha256: string;
  chunks?: string[];
  segments?: Array<{ chunk: string; offset: number; length: number }>;
  packing?: string;
  logical_stored_bytes?: number;
};

export type Manifest = {
  format: string;
  format_version: number;
  source_name: string;
  source_kind: string;
  created_unix_ns: number;
  chunking: Record<string, unknown>;
  compression: Record<string, unknown>;
  directories: string[];
  skipped_links: string[];
  files: FileRecord[];
  chunks: Record<string, ChunkRecord>;
};

export type BundleProgress = {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  path: string;
  percent: number;
};

/**
 * Streaming content-defined chunking, as FastCDC does it: a rolling gear
 * hash cuts where the content says to, so inserting bytes early in a large
 * file re-cuts one chunk instead of every chunk after it. The prototype uses
 * the `fastcdc` package; cut positions do not have to agree between writers
 * for an archive to be readable, because the manifest records the chunk list.
 */
export function chunkFrame(raw: Buffer): { frame: Buffer; record: Omit<ChunkRecord, "payload_offset"> } {
  const rawDigest = createHash("sha256").update(raw).digest();
  let codec = CODEC_NONE;
  let stored = raw;
  if (raw.length) {
    const squeezed = zstd(raw);
    // Raw storage unless compression is worth at least the stated margin.
    if (squeezed.length <= raw.length * (1 - MIN_COMPRESSION_SAVING)) {
      codec = CODEC_ZSTD;
      stored = squeezed;
    }
  }
  const storedDigest = createHash("sha256").update(stored).digest();

  const head = Buffer.alloc(CHUNK_HEADER_BYTES);
  head.write(CHUNK_MAGIC, 0, "latin1");
  head.writeUInt8(codec, 4);
  // Three padding bytes, as the "3x" in the struct format.
  head.writeBigUInt64LE(BigInt(raw.length), 8);
  head.writeBigUInt64LE(BigInt(stored.length), 16);
  rawDigest.copy(head, 24);
  storedDigest.copy(head, 56);

  return {
    frame: Buffer.concat([head, stored]),
    record: {
      raw_size: raw.length,
      stored_size: stored.length,
      codec,
      stored_sha256: storedDigest.toString("hex"),
    },
  };
}

/**
 * The original bytes of a whole chunk frame, checked against `expected`.
 *
 * A frame carries both digests, so damage to the stored bytes is caught
 * before anything is decompressed, and a frame filed under the wrong name is
 * caught after. The local store keeps each chunk as one of these, which is
 * why a chunk looks the same inside a bundle and on its own.
 */
export function openChunkFrame(frame: Buffer, expected: string): Buffer {
  if (frame.length < CHUNK_HEADER_BYTES || frame.toString("latin1", 0, 4) !== CHUNK_MAGIC) {
    throw new Error(`Chunk ${expected.slice(0, 12)} is not a chunk frame`);
  }
  const codec = frame.readUInt8(4);
  const rawSize = Number(frame.readBigUInt64LE(8));
  const storedSize = Number(frame.readBigUInt64LE(16));
  const stored = frame.subarray(CHUNK_HEADER_BYTES);
  if (
    stored.length !== storedSize ||
    sha256(stored) !== frame.subarray(56, 88).toString("hex")
  ) {
    throw new Error(`Chunk ${expected.slice(0, 12)} is damaged`);
  }
  if (codec !== CODEC_NONE && codec !== CODEC_ZSTD) {
    throw new Error(`Chunk ${expected.slice(0, 12)} uses an unknown codec (${codec})`);
  }
  const raw = codec === CODEC_ZSTD ? zstdDecompressSync(stored) : stored;
  if (raw.length !== rawSize || sha256(raw) !== expected) {
    throw new Error(`Chunk ${expected.slice(0, 12)} does not match its identity`);
  }
  return raw;
}

export type PackRequest = {
  root: string;
  target: string;
  /** Relative paths to include, in the order they should be walked. */
  entries: string[];
  sourceName: string;
  sourceKind?: string;
};

export type PackResult = {
  archiveBytes: number;
  sourceBytes: number;
  uniqueChunks: number;
  compressedChunks: number;
  duplicateBytes: number;
};

/**
 * Write a bundle. Frames stream out as files are read, and the completed
 * file is renamed into place only at the end, so an interrupted pack leaves
 * a `.partial` that is never mistaken for a finished archive.
 */
export async function packBundle(
  request: PackRequest,
  report?: (progress: BundleProgress) => void,
): Promise<PackResult> {
  const partial = `${request.target}.partial`;
  await mkdir(path.dirname(path.resolve(request.target)), { recursive: true });
  const handle = await openFile(partial, "w");

  const chunks: Record<string, ChunkRecord> = {};
  const files: FileRecord[] = [];
  const directories = new Set<string>();
  let offset = 0;
  let duplicateBytes = 0;
  let compressedChunks = 0;
  let sourceBytes = 0;

  const append = async (data: Buffer): Promise<number> => {
    const at = offset;
    await handle.write(data, 0, data.length, at);
    offset += data.length;
    return at;
  };

  try {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write(HEADER_MAGIC, 0, "latin1");
    header.writeUInt16LE(WRITTEN_FORMAT_VERSION, 4);
    header.writeUInt16LE(0, 6);
    randomBytes(16).copy(header, 8);
    await append(header);

    let totalBytes = 0;
    const sizes = new Map<string, { size: number; mtimeNs: number; mode: number }>();
    for (const relative of request.entries) {
      const info = await stat(path.join(request.root, relative));
      sizes.set(relative, {
        size: info.size,
        mtimeNs: Number(info.mtimeMs) * 1e6,
        mode: info.mode,
      });
      totalBytes += info.size;
      const parent = path.posix.dirname(relative);
      if (parent && parent !== ".") directories.add(parent);
    }

    for (const [position, relative] of request.entries.entries()) {
      const details = sizes.get(relative)!;
      report?.({
        files: position,
        totalFiles: request.entries.length,
        bytes: sourceBytes,
        totalBytes,
        path: relative,
        percent: underway(sourceBytes, totalBytes),
      });

      const whole = createHash("sha256");
      const references: string[] = [];

      const emit = async (raw: Buffer) => {
        const digest = sha256(raw);
        references.push(digest);
        if (chunks[digest]) {
          duplicateBytes += raw.length;
          return;
        }
        const { frame, record } = chunkFrame(raw);
        const at = await append(frame);
        chunks[digest] = { payload_offset: at + CHUNK_HEADER_BYTES, ...record };
        if (record.codec === CODEC_ZSTD) compressedChunks += 1;
      };

      let pending = Buffer.alloc(0);
      for await (const piece of createReadStream(
        path.join(request.root, relative),
        { highWaterMark: READ_SIZE },
      )) {
        const block = Buffer.from(piece as Buffer);
        whole.update(block);
        pending = pending.length ? Buffer.concat([pending, block]) : block;
        let from = 0;
        for (const cut of cutPoints(pending)) {
          await emit(pending.subarray(from, cut));
          from = cut;
        }
        pending = pending.subarray(from);
      }
      if (pending.length) await emit(pending);

      files.push({
        path: relative,
        size: details.size,
        mtime_ns: Math.round(details.mtimeNs),
        mode: details.mode,
        sha256: whole.digest("hex"),
        chunks: references,
        logical_stored_bytes: references.reduce(
          (total, digest) => total + (chunks[digest]?.stored_size ?? 0),
          0,
        ),
      });
      sourceBytes += details.size;
    }

    const manifest: Manifest = {
      format: "cbx-prototype",
      format_version: WRITTEN_FORMAT_VERSION,
      source_name: request.sourceName,
      source_kind: request.sourceKind ?? "directory",
      created_unix_ns: Date.now() * 1e6,
      chunking: {
        ...manifestChunking(DEFAULT_CHUNK_PROFILE),
        read_size: READ_SIZE,
        small_file_packing: { enabled: false },
      },
      compression: {
        codec: "zstd",
        level: ZSTD_LEVEL,
        minimum_saving: MIN_COMPRESSION_SAVING,
      },
      directories: [...directories].sort(),
      skipped_links: [],
      files,
      chunks,
    };

    const manifestRaw: Buffer = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestStored = zstd(manifestRaw);
    const manifestDigest = createHash("sha256").update(manifestRaw).digest();

    const manifestHead = Buffer.alloc(MANIFEST_HEADER_BYTES);
    manifestHead.write(MANIFEST_MAGIC, 0, "latin1");
    manifestHead.writeBigUInt64LE(BigInt(manifestRaw.length), 4);
    manifestHead.writeBigUInt64LE(BigInt(manifestStored.length), 12);
    manifestDigest.copy(manifestHead, 20);
    const manifestRecord = Buffer.concat([manifestHead, manifestStored]);

    const manifestOffset = await append(manifestRecord);

    const footer = Buffer.alloc(FOOTER_BYTES);
    footer.write(FOOTER_MAGIC, 0, "latin1");
    footer.writeBigUInt64LE(BigInt(manifestOffset), 4);
    footer.writeBigUInt64LE(BigInt(manifestRecord.length), 12);
    manifestDigest.copy(footer, 20);
    await append(footer);

    await handle.sync();
    await handle.close();
    await rm(request.target, { force: true });
    await rename(partial, request.target);

    /*
      The bundle is written; say so. Every other reporter here ends on a full
      bar, and this one used to stop wherever the last file started — which
      left a bundle that finished looking like one that gave up near the end.
    */
    report?.({
      files: request.entries.length,
      totalFiles: request.entries.length,
      bytes: sourceBytes,
      totalBytes,
      path: "Done",
      percent: 100,
    });

    return {
      archiveBytes: offset,
      sourceBytes,
      uniqueChunks: Object.keys(chunks).length,
      compressedChunks,
      duplicateBytes,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
}

/** Read a bundle's manifest without touching a single chunk payload. */
export async function readManifest(source: string): Promise<Manifest> {
  const handle = await openFile(source, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < HEADER_BYTES + FOOTER_BYTES) {
      throw new Error("That file is too small to be a CodeBox bundle");
    }
    const header = Buffer.alloc(HEADER_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    if (header.subarray(0, 4).toString("latin1") !== HEADER_MAGIC) {
      throw new Error("That file is not a CodeBox bundle");
    }
    const version = header.readUInt16LE(4);
    if (!SUPPORTED_FORMAT_VERSIONS.has(version)) {
      throw new Error(`This bundle needs a newer CodeRook (format ${version})`);
    }

    const footer = Buffer.alloc(FOOTER_BYTES);
    await handle.read(footer, 0, FOOTER_BYTES, size - FOOTER_BYTES);
    if (footer.subarray(0, 4).toString("latin1") !== FOOTER_MAGIC) {
      throw new Error("That bundle is incomplete");
    }
    const manifestOffset = Number(footer.readBigUInt64LE(4));
    const recordLength = Number(footer.readBigUInt64LE(12));
    const expected = footer.subarray(20, 52).toString("hex");

    const record = Buffer.alloc(recordLength);
    await handle.read(record, 0, recordLength, manifestOffset);
    if (record.subarray(0, 4).toString("latin1") !== MANIFEST_MAGIC) {
      throw new Error("That bundle's manifest record is not where it should be");
    }
    const rawLength = Number(record.readBigUInt64LE(4));
    const storedLength = Number(record.readBigUInt64LE(12));
    if (record.subarray(20, 52).toString("hex") !== expected) {
      throw new Error("That bundle's manifest digests disagree");
    }
    const stored = record.subarray(
      MANIFEST_HEADER_BYTES,
      MANIFEST_HEADER_BYTES + storedLength,
    );
    const raw = zstdDecompressSync(stored);
    if (raw.length !== rawLength || sha256(raw) !== expected) {
      throw new Error("That bundle's manifest does not match its checksum");
    }
    return JSON.parse(raw.toString("utf8")) as Manifest;
  } finally {
    await handle.close();
  }
}

/**
 * Extract a bundle into `destination`. Everything is written to a staging
 * directory beside it and moved into place only once every file has been
 * verified against the digest the manifest recorded, so a damaged archive
 * cannot leave a half-written tree looking like a finished project.
 */
export async function unpackBundle(
  source: string,
  destination: string,
  report?: (progress: BundleProgress) => void,
): Promise<{ files: number; bytes: number }> {
  const manifest = await readManifest(source);
  const handle = await openFile(source, "r");
  const staging = `${destination}.incoming`;
  await rm(staging, { recursive: true, force: true });

  // Solid packs mean several small files share one decoded chunk, so a
  // bounded cache stops the same block being decompressed for each of them.
  const cache = new Map<string, Buffer>();
  let cached = 0;

  const chunkBytes = async (digest: string): Promise<Buffer> => {
    const held = cache.get(digest);
    if (held) return held;
    const record = manifest.chunks[digest];
    if (!record) throw new Error(`The bundle is missing chunk ${digest.slice(0, 12)}`);
    const stored = Buffer.alloc(record.stored_size);
    await handle.read(stored, 0, record.stored_size, record.payload_offset);
    if (sha256(stored) !== record.stored_sha256) {
      throw new Error("A chunk in that bundle is damaged");
    }
    const raw = record.codec === CODEC_ZSTD ? zstdDecompressSync(stored) : stored;
    if (raw.length !== record.raw_size || sha256(raw) !== digest) {
      throw new Error("A chunk in that bundle does not match its identity");
    }
    if (cached + raw.length <= 64 * 1024 * 1024) {
      cache.set(digest, raw);
      cached += raw.length;
    }
    return raw;
  };

  try {
    const totalBytes = manifest.files.reduce((total, file) => total + file.size, 0);
    let written = 0;
    let bytes = 0;

    for (const directory of manifest.directories ?? []) {
      if (!directory || directory === ".") continue;
      await mkdir(inside(staging, directory), { recursive: true });
    }

    for (const record of manifest.files) {
      report?.({
        files: written,
        totalFiles: manifest.files.length,
        bytes,
        totalBytes,
        path: record.path,
        percent: underway(bytes, totalBytes),
      });

      /* Refuses `..`, absolute paths and git's own directory; see safe_path.ts. */
      const full = inside(staging, record.path);
      await mkdir(path.dirname(full), { recursive: true });

      const pieces: Buffer[] = [];
      if (record.segments) {
        for (const segment of record.segments) {
          const raw = await chunkBytes(segment.chunk);
          const end = segment.offset + segment.length;
          if (segment.offset < 0 || end > raw.length) {
            throw new Error(`Invalid solid segment in ${record.path}`);
          }
          pieces.push(raw.subarray(segment.offset, end));
        }
      } else {
        for (const digest of record.chunks ?? []) pieces.push(await chunkBytes(digest));
      }

      const contents = Buffer.concat(pieces);
      if (contents.length !== record.size || sha256(contents) !== record.sha256) {
        throw new Error(`${record.path} did not survive the bundle intact`);
      }
      await writeFile(full, contents);
      written += 1;
      bytes += contents.length;
    }

    await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    report?.({
      files: written,
      totalFiles: manifest.files.length,
      bytes,
      totalBytes,
      path: "Done",
      percent: 100,
    });
    return { files: written, bytes };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

/** Every file under `root`, relative and POSIX-separated, sorted. */
export async function collectEntries(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(root);
  return found.sort();
}
