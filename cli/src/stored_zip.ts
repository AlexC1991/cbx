/**
 * Reading the archive CodeRook builds, without a compression library.
 *
 * A clone fetched every file individually: one HTTP round trip per blob, in
 * series. Against a 21,071-file project that is 21,071 round trips, which at
 * seven tenths of a second each is four hours — and the clone that exposed
 * this simply never finished. Fetching eight at a time cut it to about half
 * an hour; asking for the version as one archive cuts it to one request.
 *
 * Written by hand for the same reason `backend/src/archive.ts` writes it by
 * hand: the entries are *stored*, never deflated, so the whole job is a
 * header, a body, and skipping the directory at the end. Pulling in a zip
 * library to not decompress anything would be a poor trade.
 *
 * Only the format that writer produces is accepted. Anything else — a
 * deflated entry, a size deferred to a data descriptor, a Zip64 field — is
 * refused rather than guessed at, and the caller falls back to fetching the
 * files one by one. A reader that quietly mangles a project is worse than a
 * slow one.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
/* An archive of nothing has no entries and no directory records — it opens
   with this, and a reader that only knew the other two would refuse it. */
const END_OF_DIRECTORY = 0x06054b50;
/** Set in the general-purpose flags when sizes come after the body. */
const SIZES_DEFERRED = 0x0008;
const STORED = 0;

export type ZipEntry = { path: string; bytes: Uint8Array };

/**
 * Every entry in a stored archive, in the order it was written.
 *
 * Deliberately whole-buffer rather than streaming: the caller is holding one
 * version's files to hand to fast-import, which needs them in order anyway,
 * and a version large enough for this to matter is one the archive path
 * should not be taking.
 */
export function readStoredZip(archive: Uint8Array): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const names = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntry[] = [];
  let at = 0;

  let ended = false;
  while (at + 4 <= archive.length) {
    const signature = view.getUint32(at, true);
    /* Either record marks the end of the entries. */
    if (signature === CENTRAL_HEADER || signature === END_OF_DIRECTORY) {
      ended = true;
      break;
    }
    if (signature !== LOCAL_HEADER) {
      throw new Error(`Not a stored archive: unexpected record at byte ${at}`);
    }
    if (at + 30 > archive.length) throw new Error("Archive ends inside a header");

    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    const compressed = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);

    if (method !== STORED) {
      throw new Error(`Archive entry is compressed (method ${method})`);
    }
    if (flags & SIZES_DEFERRED) {
      throw new Error("Archive entry defers its size to a data descriptor");
    }
    /*
      0xffffffff is Zip64's marker for "the real size is in an extra field".
      This writer never emits one, so seeing it means the archive did not come
      from where it is assumed to have come from.
    */
    if (compressed === 0xffffffff) throw new Error("Archive entry needs Zip64");

    const nameAt = at + 30;
    const bodyAt = nameAt + nameLength + extraLength;
    const end = bodyAt + compressed;
    if (end > archive.length) throw new Error("Archive ends inside an entry");

    entries.push({
      path: names.decode(archive.subarray(nameAt, nameAt + nameLength)),
      bytes: archive.subarray(bodyAt, end),
    });
    at = end;
  }

  /*
    A zip is only whole once its directory arrives.

    Running out of bytes exactly between two entries used to read as the end
    of the archive. It is also exactly what a download cut off at a file
    boundary looks like — and the service's archive of a 9,010-file version
    was being cut off, by a Worker limit, after 4,978 of them. Every one of
    those read back perfectly, so the clone took them and fetched the other
    4,032 one at a time without a word, which is why it took half an hour.
    Now the directory has to be there, and has to count what was read.
  */
  if (!ended) {
    throw new Error(
      `Archive was cut off after ${entries.length} entries: it has no directory`,
    );
  }
  const counted = directoryCount(view);
  if (counted === null) {
    throw new Error("Archive has no end-of-directory record");
  }
  if (counted !== entries.length) {
    throw new Error(
      `Archive says it holds ${counted} entries and ${entries.length} were read`,
    );
  }
  return entries;
}

/**
 * How many entries the archive's end-of-directory record says it holds.
 *
 * Searched for from the end, as the format intends: the record is the last
 * thing in the file, followed only by a comment of up to 64 KB.
 */
function directoryCount(view: DataView): number | null {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - 0xffff);
  for (let at = last; at >= first; at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) {
      return view.getUint16(at + 10, true);
    }
  }
  return null;
}
