/**
 * CodeRook's portable content-defined chunking contract.
 *
 * This file deliberately depends on no Node, Electron or browser APIs. The
 * CLI, Desktop app and website can therefore cut the same bytes at the same
 * positions. Storage manifests record the profile id; changing a profile
 * means adding a new id, never changing the meaning of an existing one.
 */

export type ChunkProfile = Readonly<{
  id: "gear-legacy-v1" | "fastcdc-v2-medium" | "fastcdc-v2-large" | "fastcdc-v2-huge" | "fastcdc-v3-micro";
  algorithm: "gear-streaming" | "fastcdc-v2";
  minSize: number;
  targetSize: number;
  maxSize: number;
  /** Rarer boundary used before the target size. */
  strictMask: number;
  /** More permissive boundary used after the target size. */
  looseMask: number;
}>;

const KIB = 1024;
const MIB = 1024 * KIB;

/*
 * Kept byte-for-byte for compatibility tests and for diagnosing old bundles.
 * The seven-bit pre-target mask is why this profile cut shortly after its
 * minimum instead of averaging eight MiB.
 */
export const LEGACY_CHUNK_PROFILE: ChunkProfile = Object.freeze({
  id: "gear-legacy-v1",
  algorithm: "gear-streaming",
  minSize: 2 * MIB,
  targetSize: 8 * MIB,
  maxSize: 32 * MIB,
  strictMask: 0x0003_5403,
  looseMask: 0x0003_5000,
});

/*
 * FastCDC normalisation uses a boundary that is half as likely before the
 * target and twice as likely afterwards. Contiguous low-bit masks contain
 * exactly the documented number of bits; the rolling gear hash mixes the
 * current byte into those bits on every step.
 */
export const MEDIUM_CHUNK_PROFILE: ChunkProfile = Object.freeze({
  id: "fastcdc-v2-medium",
  algorithm: "fastcdc-v2",
  minSize: 256 * KIB,
  targetSize: 1 * MIB,
  maxSize: 4 * MIB,
  strictMask: 0x001f_ffff,
  looseMask: 0x0007_ffff,
});

export const LARGE_CHUNK_PROFILE: ChunkProfile = Object.freeze({
  id: "fastcdc-v2-large",
  algorithm: "fastcdc-v2",
  minSize: 1 * MIB,
  targetSize: 4 * MIB,
  maxSize: 16 * MIB,
  strictMask: 0x007f_ffff,
  looseMask: 0x001f_ffff,
});

export const HUGE_CHUNK_PROFILE: ChunkProfile = Object.freeze({
  id: "fastcdc-v2-huge",
  algorithm: "fastcdc-v2",
  minSize: 2 * MIB,
  targetSize: 8 * MIB,
  maxSize: 32 * MIB,
  strictMask: 0x00ff_ffff,
  looseMask: 0x003f_ffff,
});

export const DEFAULT_CHUNK_PROFILE = HUGE_CHUNK_PROFILE;

/**
 * Fine-grained large-file transport. It uses the same portable FastCDC
 * boundary function but keeps edit amplification near one MiB instead of
 * four to eight MiB. Existing Versions retain their recorded chunk objects.
 */
export const MICRO_CHUNK_PROFILE: ChunkProfile = Object.freeze({
  id: "fastcdc-v3-micro",
  algorithm: "fastcdc-v2",
  minSize: 256 * KIB,
  targetSize: 1 * MIB,
  maxSize: 4 * MIB,
  strictMask: 0x001f_ffff,
  looseMask: 0x0007_ffff,
});

/** The profile repository uploads use for a file of `size` bytes. */
export function profileForFileSize(size: number): ChunkProfile | null {
  if (!Number.isFinite(size) || size < 0) {
    throw new RangeError("File size must be a finite non-negative number");
  }
  if (size < 8 * MIB) return null;
  if (size < 128 * MIB) return MEDIUM_CHUNK_PROFILE;
  if (size < 2 * 1024 * MIB) return LARGE_CHUNK_PROFILE;
  return HUGE_CHUNK_PROFILE;
}

/** New-write profile when the service advertises the microchunk map. */
export function microchunkProfileForFileSize(size: number): ChunkProfile | null {
  const legacy = profileForFileSize(size);
  return legacy ? MICRO_CHUNK_PROFILE : null;
}

const GEAR = (() => {
  const table = new Uint32Array(256);
  let seed = 0x9e3779b9;
  for (let index = 0; index < 256; index += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    table[index] = seed;
  }
  return table;
})();

/**
 * Cut positions inside `bytes`; the final tail is deliberately left to the
 * streaming caller. Supplying the same bytes and profile on any platform
 * must always return the same positions.
 */
export function cutPoints(
  bytes: Uint8Array,
  profile: ChunkProfile = DEFAULT_CHUNK_PROFILE,
): number[] {
  const cuts: number[] = [];
  let from = 0;
  let hash = 0;
  for (let at = 0; at < bytes.length; at += 1) {
    hash = ((hash << 1) + GEAR[bytes[at]!]!) >>> 0;
    const length = at - from + 1;
    if (length < profile.minSize) continue;
    const mask = length < profile.targetSize
      ? profile.strictMask
      : profile.looseMask;
    if (length >= profile.maxSize || (hash & mask) === 0) {
      cuts.push(at + 1);
      from = at + 1;
      hash = 0;
    }
  }
  return cuts;
}

/** Full piece boundaries, including the final tail. */
export function chunkBoundaries(
  bytes: Uint8Array,
  profile: ChunkProfile = DEFAULT_CHUNK_PROFILE,
): number[] {
  const bounds = cutPoints(bytes, profile);
  if (bounds[bounds.length - 1] !== bytes.length) bounds.push(bytes.length);
  return bounds;
}

export function manifestChunking(profile: ChunkProfile): Record<string, unknown> {
  return {
    algorithm: profile.algorithm,
    profile: profile.id,
    min_size: profile.minSize,
    avg_size: profile.targetSize,
    max_size: profile.maxSize,
  };
}
