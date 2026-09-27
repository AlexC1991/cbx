/**
 * Many files compressed as one stream, the way the .cbx format does it.
 *
 * The upload path used to gzip each file on its own. That is the wrong shape
 * for what a project actually holds: measured on a real folder, fifteen
 * hundred small source files came to 42.9% of their size compressed
 * individually and 30.2% compressed together. A two-kilobyte file gives a
 * compressor nothing to work with — it starts cold, builds a dictionary out of
 * two kilobytes, and throws it away. A thousand files from the same project
 * share an enormous vocabulary, and only a shared stream can spend it.
 *
 * Notably the codec is not where the win is. Per-file zstd measured *worse*
 * than per-file gzip on the same files (44.4% against 42.9%); it is the
 * sharing that pays, not the algorithm.
 *
 * Gzip is used here rather than the format's Zstandard because the service has
 * to be able to open a pack to serve one file out of it, and the Worker
 * runtime can decompress gzip and cannot decompress zstd. That costs some
 * ratio — zstd reached 30.2% where gzip reaches 36.2% — and it is the whole
 * of the difference between this and what `packBundle` writes to disk.
 */
import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const deflate = promisify(gzip);

/** One file's place inside the pack's decompressed stream. */
export type PackedMember = {
  /** Digest of the file's own bytes, which is its identity everywhere else. */
  sha256: string;
  offset: number;
  length: number;
};

export type SolidPack = {
  /** The compressed pack, as it travels and as it is stored. */
  body: Uint8Array;
  /** Digest of the compressed bytes, for the service to verify on arrival. */
  storedSha256: string;
  /** Digest of the decompressed stream, which is the pack's own identity. */
  sha256: string;
  /** How long the stream is once decompressed. */
  size: number;
  members: PackedMember[];
};

/**
 * Build one pack from a set of files.
 *
 * Members are laid end to end in the order given and each one's position is
 * recorded, so the service can hand back any single file by decompressing up
 * to its offset. Order is therefore not arbitrary: it is the index.
 *
 * Returns null when packing is not worth it — a pack of one file is just a
 * compressed file with extra bookkeeping, and a pack that did not compress is
 * a decompression step the service would pay for on every read forever.
 */
export async function buildSolidPack(
  files: Array<{ sha256: string; body: Uint8Array }>,
): Promise<SolidPack | null> {
  if (files.length < 2) return null;

  const members: PackedMember[] = [];
  let offset = 0;
  for (const file of files) {
    members.push({
      sha256: file.sha256,
      offset,
      length: file.body.byteLength,
    });
    offset += file.body.byteLength;
  }

  const stream = new Uint8Array(offset);
  let at = 0;
  for (const file of files) {
    stream.set(file.body, at);
    at += file.body.byteLength;
  }

  /*
    Ask a sample before compressing the whole thing.

    Measured across a hundred and eighty real files, trial-compressing sixty
    four kilobytes predicted the whole file's answer in all but one case — and
    that one erred towards trying, which costs milliseconds, rather than
    towards skipping, which would lose a real saving.

    It matters most exactly where packing is pointless: a pack of already
    compressed images or video would otherwise be gzipped in full, at some
    tens of megabytes per second, to discover what a sixty four kilobyte probe
    says in under two milliseconds.
  */
  const probe = stream.subarray(0, Math.min(64 * 1024, stream.byteLength));
  try {
    const sampled = await deflate(probe, { level: 6 });
    if (sampled.byteLength >= probe.byteLength * 0.95) return null;
  } catch {
    return null;
  }

  let packed: Buffer;
  try {
    packed = await deflate(stream, { level: 6 });
  } catch {
    return null;
  }
  /*
    Measured, not assumed. A pack of already-compressed files — a folder of
    images, a directory of archives — comes out no smaller, and storing it as
    a pack would buy nothing while making every later read of a single file
    decompress the whole thing up to its offset.
  */
  if (packed.byteLength >= stream.byteLength * 0.95) return null;

  return {
    body: new Uint8Array(packed),
    storedSha256: createHash("sha256").update(packed).digest("hex"),
    sha256: createHash("sha256").update(stream).digest("hex"),
    size: stream.byteLength,
    members,
  };
}
