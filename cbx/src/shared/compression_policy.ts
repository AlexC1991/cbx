/*
 * The storage representation decision is a protocol rule, not a desktop UI
 * preference. Keep the cheap, deterministic part of it in a runtime-neutral
 * module so Desktop, CLI (through Desktop's uploader), Website and the Worker
 * make the same decision for the same object.
 */

const ALREADY_COMPRESSED = new Set([
  ".7z", ".aac", ".avi", ".br", ".bz2", ".cbx", ".docx", ".flac", ".gif",
  ".gguf", ".gz", ".heic", ".jpeg", ".jpg", ".jxl", ".m4a", ".m4v", ".mkv",
  ".mov", ".mp3", ".mp4", ".odp", ".ods", ".odt", ".ogg", ".onnx", ".opus",
  ".pdf", ".png", ".pptx", ".rar", ".safetensors", ".webm", ".webp", ".xlsx",
  ".xz", ".zip", ".zst",
]);

export const SMALLEST_WORTH_COMPRESSING = 4 * 1024;
export const WORTHWHILE_COMPRESSION_RATIO = 0.95;

export function looksCompressed(relativePath: string): boolean {
  const dot = relativePath.lastIndexOf(".");
  if (dot < 0) return false;
  return ALREADY_COMPRESSED.has(relativePath.slice(dot).toLowerCase());
}

export function shouldTryGzip(
  relativePath: string,
  sourceBytes: number,
  allowGzip: boolean,
): boolean {
  return (
    allowGzip &&
    sourceBytes >= SMALLEST_WORTH_COMPRESSING &&
    !looksCompressed(relativePath)
  );
}

/**
 * Above this, find out by trying a little before trying all of it.
 *
 * The extension list above is a guess, and the cost of a miss is unbounded.
 * A project of thirteen `.gguf` model weights — 10.6 GB, an extension nothing
 * here had heard of — was deflated at level 6, in full, to discover that it
 * compressed by 3.3% and the result had to be thrown away. That was 87% of the
 * time the save spent before it sent a single byte, and the save runs the whole
 * pipeline twice, so it was paid twice. The project never finished saving.
 *
 * A quarter of a megabyte is eight times deflate's window, which is enough for
 * the answer to mean something, and 6% of a maximum chunk, which is what makes
 * a wrong guess in the list above cheap instead of ruinous.
 */
export const SAMPLE_BYTES = 256 * 1024;

/** Whether a piece is big enough that guessing wrong on it is worth avoiding. */
export function worthSampling(sourceBytes: number): boolean {
  /*
    Only where the sample is a real saving over the whole thing. Sampling a
    300 KB file costs most of what compressing it would and answers a question
    that was about to be answered properly anyway.
  */
  return sourceBytes >= SAMPLE_BYTES * 8;
}

/**
 * Where to look, for a piece of this size.
 *
 * Two windows, not one, because a single window at the front judges the whole
 * file by its header. A container with a text manifest and an incompressible
 * payload would be compressed in full on the strength of its first block —
 * which is the waste this exists to avoid — and one shaped the other way round
 * would be abandoned despite compressing. The middle disagrees with the front
 * in both cases, and either window arguing for compression is enough.
 *
 * Shared rather than chosen per caller so Desktop and the browser make the same
 * decision about the same bytes, which is the point of this module.
 */
export function sampleWindows(
  sourceBytes: number,
): Array<{ at: number; size: number }> {
  return [
    { at: 0, size: SAMPLE_BYTES },
    { at: Math.floor(sourceBytes / 2), size: SAMPLE_BYTES },
  ];
}

/**
 * Whether a window that compressed this little argues against the whole piece.
 *
 * Deliberately the same test {@link gzipIsWorthKeeping} applies at the end: the
 * sample is an estimate of that answer, so estimating it against a softer
 * threshold was the bug in the first attempt at this. A window that saved 3%
 * would have passed a "did it compress at all" test, committed the file to a
 * full deflate, and then had the result discarded for saving 3% — which is
 * exactly the several minutes this was meant to stop spending.
 *
 * Getting it wrong costs a little space and never a wrong result: an object's
 * identity is the digest of its original bytes, whatever travels.
 */
export function sampleSaysDoNotBother(
  sampleBytes: number,
  compressedSampleBytes: number,
): boolean {
  return !gzipIsWorthKeeping(sampleBytes, compressedSampleBytes);
}

export function gzipIsWorthKeeping(
  sourceBytes: number,
  compressedBytes: number,
): boolean {
  return compressedBytes < sourceBytes * WORTHWHILE_COMPRESSION_RATIO;
}

/**
 * What one file has learnt so far about whether compressing it is worth it.
 *
 * Per file, never per upload: a project of model weights and source code must
 * not let the weights decide for the source.
 *
 * `tried` and `kept` cover the *current* review window rather than the whole
 * file, and `chunks` counts the file — see {@link noteChunkOutcome} for why the
 * window is what gets judged.
 */
export type GzipVerdict = {
  allowed: boolean;
  tried: number;
  kept: number;
  chunks: number;
};

/** How often a chunked file's compression is reviewed. */
export const GZIP_REVIEW_EVERY = 16;
/** The fraction of reviewed chunks that must have kept gzip, as its divisor. */
export const GZIP_KEEP_RATE = 4;

/** A file nothing is known about yet. */
export function freshGzipVerdict(): GzipVerdict {
  return { allowed: true, tried: 0, kept: 0, chunks: 0 };
}

/**
 * Record how one chunk turned out, and decide whether to keep trying.
 *
 * A large file is not one object, it is hundreds: a 1 GB file at a 1 MB target
 * is a thousand chunks, each compressed and judged on its own. So the guard
 * that stops wasted work on a whole *file* cannot live in the piece — sampling
 * inside a 1 MB chunk saves a fraction of a job that was already small.
 *
 * Thirteen `.gguf` model weights, 10.6 GB, went chunk by chunk through deflate
 * at level 6. That was 87% of the time the save spent before it sent a byte,
 * and a save runs the whole pipeline twice, so it was spent twice. The project
 * never finished saving.
 *
 * Measured on one of those files, 24 of 208 chunks did clear the 5% threshold
 * and keep their compression — so "give up once nothing has compressed" never
 * fired, which was the first attempt at this. What those 24 chunks saved was
 * 0.7% of the file. The question is a rate, not an existence.
 *
 * Each window is judged on itself, and the count starts again after every
 * review. Judging the file cumulatively instead lets a compressible opening buy
 * an arbitrarily long incompressible tail: a run of 256 chunks that compressed
 * would carry the next thousand that did not, which is the cost this exists to
 * bound. Starting again means the work wasted after a file changes character is
 * never more than one window, whereever in the file that happens.
 *
 * Being wrong costs a little storage and never a wrong result: an object's
 * identity is the digest of its original bytes, whatever those bytes travelled
 * as, so chunks already sent compressed stay exactly as valid as before.
 */
export function noteChunkOutcome(
  verdict: GzipVerdict,
  keptGzip: boolean,
): void {
  if (!verdict.allowed) return;
  verdict.chunks += 1;
  verdict.tried += 1;
  if (keptGzip) verdict.kept += 1;
  if (verdict.tried < GZIP_REVIEW_EVERY) return;
  if (verdict.kept * GZIP_KEEP_RATE < verdict.tried) {
    verdict.allowed = false;
    return;
  }
  verdict.tried = 0;
  verdict.kept = 0;
}
