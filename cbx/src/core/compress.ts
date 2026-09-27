/**
 * Compressing an object before it is sent.
 *
 * The service stores an object either as it arrived or gzipped, and records
 * which on the row: the digest in the path is always the *original* bytes, so
 * an object keeps one identity however it happened to travel. That is what
 * lets the same file be sent compressed by one client and plain by another
 * and still be recognised as the file it already has.
 *
 * The desktop app never used it. Every upload went as raw bytes, which is why
 * the account overview reports nothing saved — there was nothing to report.
 * The cost was paid twice: once in the person's upload time, and again in the
 * storage they are charged for.
 *
 * Two rules keep this from being a pessimisation:
 *
 * Already-compressed formats are left alone. Gzipping a PNG, a zip or an mp4
 * spends real time to make the file slightly bigger, and those are exactly the
 * large files where the wasted effort is most noticeable.
 *
 * And a result that did not save anything is thrown away. The check is on the
 * outcome rather than on the guess — a ".bin" that turns out to be text gets
 * compressed, a ".txt" full of random data does not stay compressed.
 */
import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import {
  gzipIsWorthKeeping,
  sampleSaysDoNotBother,
  sampleWindows,
  shouldTryGzip,
  worthSampling,
} from "../shared/compression_policy";

export { looksCompressed } from "../shared/compression_policy";

const deflate = promisify(gzip);

/** What actually travels, and what to tell the service about it. */
export type Encoded = {
  body: Uint8Array;
  /** "identity" when the original bytes are being sent as they are. */
  encoding: "identity" | "gzip";
  /** Digest of the bytes in `body`. Only needed when they are not the original. */
  storedSha256: string;
};

/*
  Extensions whose contents are already compressed. Matching on the name is a
  guess, but it is the cheap half of the decision — the expensive half, below,
  is measured rather than guessed, so a wrong entry here costs a little time
  and never a wrong result.
*/
/**
 * Decide how one object should travel.
 *
 * Never throws for compression reasons: if anything goes wrong the original
 * bytes are sent, because a failed optimisation must not become a failed
 * upload.
 */
export async function encodeForUpload(
  original: Uint8Array,
  relativePath: string,
  allowGzip: boolean,
): Promise<Encoded> {
  const plain: Encoded = {
    body: original,
    encoding: "identity",
    storedSha256: "",
  };
  if (!shouldTryGzip(relativePath, original.byteLength, allowGzip)) return plain;

  try {
    /*
      Ask a little of it before asking all of it.

      The extension list is a guess and the cost of a miss used to be the whole
      file. Two sampled windows make it an eighth of that, which is what lets
      the decision stay measured — the principle above — for a format nothing
      here has heard of, instead of measured-at-any-price.
    */
    if (worthSampling(original.byteLength)) {
      let anyWindowArguesFor = false;
      for (const window of sampleWindows(original.byteLength)) {
        const sample = original.subarray(window.at, window.at + window.size);
        const tried = await deflate(sample, { level: 6 });
        if (!sampleSaysDoNotBother(sample.byteLength, tried.byteLength)) {
          anyWindowArguesFor = true;
          break;
        }
      }
      if (!anyWindowArguesFor) return plain;
    }
    const packed = await deflate(original, { level: 6 });
    if (!gzipIsWorthKeeping(original.byteLength, packed.byteLength)) return plain;
    return {
      body: new Uint8Array(packed),
      encoding: "gzip",
      storedSha256: createHash("sha256").update(packed).digest("hex"),
    };
  } catch {
    return plain;
  }
}
