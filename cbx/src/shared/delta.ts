/**
 * CodeRook's changed-file transport delta.
 *
 * This is deliberately not a fourth permanent storage shape. The receiver
 * describes blocks from the complete file it already has, the sender emits a
 * short stream of COPY and INSERT operations, and the receiver reconstructs a
 * complete object before it is admitted to the ordinary object catalogue.
 *
 * The shape follows the useful part of rsync and Git pack deltas without
 * inheriting delta chains: a rolling weak checksum finds candidate blocks, a
 * second checksum rejects ordinary collisions, and the final file SHA-256 is
 * still the authority at the API boundary.
 */

const SIGNATURE_MAGIC_V1 = [0x43, 0x52, 0x53, 0x31] as const; // CRS1
const SIGNATURE_MAGIC_V2 = [0x43, 0x52, 0x53, 0x32] as const; // CRS2
const PATCH_MAGIC_V1 = [0x43, 0x52, 0x50, 0x31] as const; // CRP1
const PATCH_MAGIC_V2 = [0x43, 0x52, 0x50, 0x32] as const; // CRP2
const ENVELOPE_MAGIC_V2 = [0x43, 0x44, 0x45, 0x32] as const; // CDE2
const SIGNATURE_BATCH_MAGIC_V2 = [0x43, 0x44, 0x53, 0x32] as const; // CDS2
const DELTA_BATCH_MAGIC_V2 = [0x43, 0x44, 0x42, 0x32] as const; // CDB2
const SIGNATURE_HEADER_V1_BYTES = 16;
const SIGNATURE_HEADER_V2_BYTES = 12;
const SIGNATURE_RECORD_V1_BYTES = 8;
const SIGNATURE_RECORD_V2_BYTES = 6;
const PATCH_HEADER_V1_BYTES = 12;
const COPY_BYTES = 9;
const LITERAL_HEADER_BYTES = 5;
const ENVELOPE_V2_FIXED_BYTES = 55;
const MOD_ADLER = 65_521;

/** Bound Worker memory and make malformed requests cheap to reject. */
export const DELTA_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DELTA_BATCH_MAX_FILES = 64;
export const DELTA_BATCH_MAX_SOURCE_BYTES = 24 * 1024 * 1024;

export type DeltaSignature = {
  version: 1 | 2;
  blockSize: number;
  baseSize: number;
  strongBits: 16 | 32;
  blocks: Array<{ weak: number; strong: number }>;
  byteLength: number;
};

export type DeltaEnvelope = {
  baseVersionId: string;
  path: string;
  sha256: string;
  mediaType: string;
  patch: Uint8Array;
};

export type DeltaBatchEnvelope = {
  baseVersionId: string;
  entries: Array<Omit<DeltaEnvelope, "baseVersionId">>;
};

type DeltaOperation =
  | { kind: "copy"; offset: number; length: number }
  | { kind: "literal"; bytes: Uint8Array };

function sameMagic(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value && power < 0x4000_0000) power *= 2;
  return power;
}

/**
 * Keep signature replies small while retaining fine matches.
 *
 * sqrt(file size), rounded to a power of two, is the traditional useful shape
 * for receiver signatures: an 8 KiB file uses 128-byte blocks and sends only
 * 512 bytes of checksum records; an 8 MiB file uses 4 KiB blocks and sends
 * 16 KiB of records.
 */
export function deltaBlockSize(size: number, version: 1 | 2 = 1): number {
  /*
    V2 minimizes the bytes on both sides, rather than only the number of
    literal bytes in the patch. Six checksum bytes are paid for every block,
    while a narrow edit normally invalidates one complete block. The minimum
    of those two costs is close to sqrt(fileSize * recordSize).
  */
  const weight = version === 2 ? SIGNATURE_RECORD_V2_BYTES : 1;
  const wanted = Math.ceil(Math.sqrt(Math.max(1, size) * weight));
  return Math.min(16 * 1024, Math.max(64, nextPowerOfTwo(wanted)));
}

function weakChecksum(bytes: Uint8Array, offset: number, length: number): number {
  let a = 0;
  let b = 0;
  for (let index = 0; index < length; index += 1) {
    const value = bytes[offset + index] ?? 0;
    a += value;
    b += (length - index) * value;
  }
  a %= MOD_ADLER;
  b %= MOD_ADLER;
  return (((b << 16) | a) >>> 0);
}

function rollWeak(
  checksum: number,
  outgoing: number,
  incoming: number,
  length: number,
): number {
  let a = (checksum & 0xffff) - outgoing + incoming;
  a %= MOD_ADLER;
  if (a < 0) a += MOD_ADLER;
  let b = (checksum >>> 16) - length * outgoing + a;
  b %= MOD_ADLER;
  if (b < 0) b += MOD_ADLER;
  return (((b << 16) | a) >>> 0);
}

/** A fast second opinion. Final reconstruction is still verified by SHA-256. */
function strongChecksum(bytes: Uint8Array, offset: number, length: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < length; index += 1) {
    hash ^= bytes[offset + index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function estimateDeltaSignatureBytes(
  baseSize: number,
  version: 1 | 2 = 1,
): number {
  const blockSize = deltaBlockSize(baseSize, version);
  return version === 2
    ? SIGNATURE_HEADER_V2_BYTES +
        Math.floor(baseSize / blockSize) * SIGNATURE_RECORD_V2_BYTES
    : SIGNATURE_HEADER_V1_BYTES +
        Math.floor(baseSize / blockSize) * SIGNATURE_RECORD_V1_BYTES;
}

export function createDeltaSignature(
  base: Uint8Array,
  version: 1 | 2 = 1,
): Uint8Array {
  if (base.byteLength > DELTA_MAX_FILE_BYTES) {
    throw new Error("Delta base exceeds the bounded transport limit");
  }
  const blockSize = deltaBlockSize(base.byteLength, version);
  const count = Math.floor(base.byteLength / blockSize);
  const headerBytes =
    version === 2 ? SIGNATURE_HEADER_V2_BYTES : SIGNATURE_HEADER_V1_BYTES;
  const recordBytes =
    version === 2 ? SIGNATURE_RECORD_V2_BYTES : SIGNATURE_RECORD_V1_BYTES;
  const out = new Uint8Array(headerBytes + count * recordBytes);
  out.set(version === 2 ? SIGNATURE_MAGIC_V2 : SIGNATURE_MAGIC_V1, 0);
  const view = new DataView(out.buffer);
  if (version === 2) {
    view.setUint16(4, blockSize, false);
    out[6] = 16;
    out[7] = 0;
    view.setUint32(8, base.byteLength, false);
  } else {
    view.setUint32(4, blockSize, false);
    view.setUint32(8, base.byteLength, false);
    view.setUint32(12, count, false);
  }
  for (let index = 0; index < count; index += 1) {
    const offset = index * blockSize;
    const at = headerBytes + index * recordBytes;
    view.setUint32(at, weakChecksum(base, offset, blockSize), false);
    if (version === 2) {
      view.setUint16(
        at + 4,
        strongChecksum(base, offset, blockSize) & 0xffff,
        false,
      );
    } else {
      view.setUint32(at + 4, strongChecksum(base, offset, blockSize), false);
    }
  }
  return out;
}

export function parseDeltaSignature(bytes: Uint8Array): DeltaSignature {
  const version = sameMagic(bytes, SIGNATURE_MAGIC_V2)
    ? 2
    : sameMagic(bytes, SIGNATURE_MAGIC_V1)
      ? 1
      : 0;
  const headerBytes =
    version === 2 ? SIGNATURE_HEADER_V2_BYTES : SIGNATURE_HEADER_V1_BYTES;
  const recordBytes =
    version === 2 ? SIGNATURE_RECORD_V2_BYTES : SIGNATURE_RECORD_V1_BYTES;
  if (!version || bytes.byteLength < headerBytes) {
    throw new Error("Delta signature is malformed");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockSize =
    version === 2 ? view.getUint16(4, false) : view.getUint32(4, false);
  const baseSize = view.getUint32(8, false);
  const count =
    version === 2 ? Math.floor(baseSize / blockSize) : view.getUint32(12, false);
  if (
    blockSize < 64 ||
    blockSize > 16 * 1024 ||
    baseSize > DELTA_MAX_FILE_BYTES ||
    (version === 2 && (bytes[6] !== 16 || bytes[7] !== 0)) ||
    count !== Math.floor(baseSize / blockSize) ||
    bytes.byteLength !== headerBytes + count * recordBytes
  ) {
    throw new Error("Delta signature dimensions are invalid");
  }
  const blocks: DeltaSignature["blocks"] = [];
  for (let index = 0; index < count; index += 1) {
    const at = headerBytes + index * recordBytes;
    blocks.push({
      weak: view.getUint32(at, false),
      strong:
        version === 2
          ? view.getUint16(at + 4, false)
          : view.getUint32(at + 4, false),
    });
  }
  return {
    version,
    blockSize,
    baseSize,
    strongBits: version === 2 ? 16 : 32,
    blocks,
    byteLength: bytes.byteLength,
  };
}

function appendOperation(operations: DeltaOperation[], operation: DeltaOperation): void {
  if (operation.kind === "literal" && operation.bytes.byteLength === 0) return;
  if (operation.kind === "copy" && operation.length === 0) return;
  const previous = operations[operations.length - 1];
  if (
    previous?.kind === "copy" &&
    operation.kind === "copy" &&
    previous.offset + previous.length === operation.offset
  ) {
    previous.length += operation.length;
    return;
  }
  if (previous?.kind === "literal" && operation.kind === "literal") {
    const joined = new Uint8Array(previous.bytes.byteLength + operation.bytes.byteLength);
    joined.set(previous.bytes);
    joined.set(operation.bytes, previous.bytes.byteLength);
    previous.bytes = joined;
    return;
  }
  operations.push(operation);
}

function varUintBytes(value: number): number {
  let remaining = value >>> 0;
  let count = 1;
  while (remaining >= 0x80) {
    remaining >>>= 7;
    count += 1;
  }
  return count;
}

function writeVarUint(out: Uint8Array, offset: number, value: number): number {
  let remaining = value >>> 0;
  let at = offset;
  while (remaining >= 0x80) {
    out[at] = (remaining & 0x7f) | 0x80;
    remaining >>>= 7;
    at += 1;
  }
  out[at] = remaining;
  return at + 1;
}

function readVarUint(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (let count = 0; count < 5; count += 1) {
    if (at >= bytes.byteLength) throw new Error("Delta varint is truncated");
    const byte = bytes[at] ?? 0;
    if (count === 4 && (byte & 0xf0) !== 0) {
      throw new Error("Delta varint exceeds 32 bits");
    }
    value = (value | ((byte & 0x7f) << shift)) >>> 0;
    at += 1;
    if ((byte & 0x80) === 0) {
      if (count > 0 && byte === 0) {
        throw new Error("Delta varint is not canonical");
      }
      return { value, next: at };
    }
    shift += 7;
  }
  throw new Error("Delta varint is malformed");
}

function encodePatchV1(targetSize: number, operations: DeltaOperation[]): Uint8Array {
  const total =
    PATCH_HEADER_V1_BYTES +
    operations.reduce(
      (sum, operation) =>
        sum +
        (operation.kind === "copy"
          ? COPY_BYTES
          : LITERAL_HEADER_BYTES + operation.bytes.byteLength),
      0,
    );
  const out = new Uint8Array(total);
  out.set(PATCH_MAGIC_V1, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, targetSize, false);
  view.setUint32(8, operations.length, false);
  let at = PATCH_HEADER_V1_BYTES;
  for (const operation of operations) {
    if (operation.kind === "copy") {
      out[at] = 1;
      view.setUint32(at + 1, operation.offset, false);
      view.setUint32(at + 5, operation.length, false);
      at += COPY_BYTES;
    } else {
      out[at] = 0;
      view.setUint32(at + 1, operation.bytes.byteLength, false);
      out.set(operation.bytes, at + LITERAL_HEADER_BYTES);
      at += LITERAL_HEADER_BYTES + operation.bytes.byteLength;
    }
  }
  return out;
}

function encodePatchV2(targetSize: number, operations: DeltaOperation[]): Uint8Array {
  const total =
    4 +
    varUintBytes(targetSize) +
    varUintBytes(operations.length) +
    operations.reduce(
      (sum, operation) =>
        sum +
        1 +
        (operation.kind === "copy"
          ? varUintBytes(operation.offset) + varUintBytes(operation.length)
          : varUintBytes(operation.bytes.byteLength) + operation.bytes.byteLength),
      0,
    );
  const out = new Uint8Array(total);
  out.set(PATCH_MAGIC_V2, 0);
  let at = writeVarUint(out, 4, targetSize);
  at = writeVarUint(out, at, operations.length);
  for (const operation of operations) {
    if (operation.kind === "copy") {
      out[at] = 1;
      at = writeVarUint(out, at + 1, operation.offset);
      at = writeVarUint(out, at, operation.length);
    } else {
      out[at] = 0;
      at = writeVarUint(out, at + 1, operation.bytes.byteLength);
      out.set(operation.bytes, at);
      at += operation.bytes.byteLength;
    }
  }
  return out;
}

/** Build COPY/INSERT operations from receiver signatures, without base bytes. */
export function createDeltaPatch(
  target: Uint8Array,
  signature: DeltaSignature,
): Uint8Array {
  if (target.byteLength > DELTA_MAX_FILE_BYTES) {
    throw new Error("Delta target exceeds the bounded transport limit");
  }
  if (signature.blocks.length === 0 || target.byteLength < signature.blockSize) {
    const literal = [{ kind: "literal", bytes: target.slice() }] as DeltaOperation[];
    return signature.version === 2
      ? encodePatchV2(target.byteLength, literal)
      : encodePatchV1(target.byteLength, literal);
  }

  const candidates = new Map<number, number[]>();
  signature.blocks.forEach((block, index) => {
    const list = candidates.get(block.weak) ?? [];
    // Repeated zero-filled blocks can otherwise make adversarial work quadratic.
    if (list.length < 64) list.push(index);
    candidates.set(block.weak, list);
  });

  const operations: DeltaOperation[] = [];
  const width = signature.blockSize;
  let cursor = 0;
  let literalStart = 0;
  let weak = weakChecksum(target, 0, width);

  while (cursor + width <= target.byteLength) {
    const possible = candidates.get(weak);
    let matched = -1;
    if (possible?.length) {
      const strong = strongChecksum(target, cursor, width);
      matched = possible.find(
        (index) =>
          signature.blocks[index]?.strong ===
          (signature.strongBits === 16 ? strong & 0xffff : strong),
      ) ?? -1;
    }
    if (matched >= 0) {
      appendOperation(operations, {
        kind: "literal",
        bytes: target.slice(literalStart, cursor),
      });
      appendOperation(operations, {
        kind: "copy",
        offset: matched * width,
        length: width,
      });
      cursor += width;
      literalStart = cursor;
      if (cursor + width <= target.byteLength) {
        weak = weakChecksum(target, cursor, width);
      }
      continue;
    }

    if (cursor + width >= target.byteLength) break;
    weak = rollWeak(
      weak,
      target[cursor] ?? 0,
      target[cursor + width] ?? 0,
      width,
    );
    cursor += 1;
  }
  appendOperation(operations, {
    kind: "literal",
    bytes: target.slice(literalStart),
  });
  return signature.version === 2
    ? encodePatchV2(target.byteLength, operations)
    : encodePatchV1(target.byteLength, operations);
}

/** Apply an untrusted patch with strict bounds; the route verifies SHA-256 next. */
export function deltaPatchTargetSize(patch: Uint8Array): number {
  if (sameMagic(patch, PATCH_MAGIC_V2)) {
    const field = readVarUint(patch, 4);
    if (field.value > DELTA_MAX_FILE_BYTES) {
      throw new Error("Delta patch target exceeds the transport limit");
    }
    return field.value;
  }
  if (
    patch.byteLength < PATCH_HEADER_V1_BYTES ||
    !sameMagic(patch, PATCH_MAGIC_V1)
  ) {
    throw new Error("Delta patch is malformed");
  }
  const size = new DataView(
    patch.buffer,
    patch.byteOffset,
    patch.byteLength,
  ).getUint32(4, false);
  if (size > DELTA_MAX_FILE_BYTES) {
    throw new Error("Delta patch target exceeds the transport limit");
  }
  return size;
}

export function applyDeltaPatch(base: Uint8Array, patch: Uint8Array): Uint8Array {
  if (sameMagic(patch, PATCH_MAGIC_V2)) {
    return applyDeltaPatchV2(base, patch);
  }
  if (
    patch.byteLength < PATCH_HEADER_V1_BYTES ||
    !sameMagic(patch, PATCH_MAGIC_V1)
  ) {
    throw new Error("Delta patch is malformed");
  }
  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
  const targetSize = view.getUint32(4, false);
  const operationCount = view.getUint32(8, false);
  if (targetSize > DELTA_MAX_FILE_BYTES || operationCount > 1_000_000) {
    throw new Error("Delta patch dimensions are invalid");
  }
  const out = new Uint8Array(targetSize);
  let readAt = PATCH_HEADER_V1_BYTES;
  let writeAt = 0;
  for (let index = 0; index < operationCount; index += 1) {
    if (readAt >= patch.byteLength) throw new Error("Delta patch is truncated");
    const opcode = patch[readAt];
    if (opcode === 1) {
      if (readAt + COPY_BYTES > patch.byteLength) {
        throw new Error("Delta copy operation is truncated");
      }
      const offset = view.getUint32(readAt + 1, false);
      const length = view.getUint32(readAt + 5, false);
      if (
        length === 0 ||
        offset + length > base.byteLength ||
        writeAt + length > out.byteLength
      ) {
        throw new Error("Delta copy operation is out of bounds");
      }
      out.set(base.subarray(offset, offset + length), writeAt);
      writeAt += length;
      readAt += COPY_BYTES;
      continue;
    }
    if (opcode === 0) {
      if (readAt + LITERAL_HEADER_BYTES > patch.byteLength) {
        throw new Error("Delta literal operation is truncated");
      }
      const length = view.getUint32(readAt + 1, false);
      const from = readAt + LITERAL_HEADER_BYTES;
      if (
        length === 0 ||
        from + length > patch.byteLength ||
        writeAt + length > out.byteLength
      ) {
        throw new Error("Delta literal operation is out of bounds");
      }
      out.set(patch.subarray(from, from + length), writeAt);
      writeAt += length;
      readAt = from + length;
      continue;
    }
    throw new Error("Delta patch contains an unknown operation");
  }
  if (readAt !== patch.byteLength || writeAt !== out.byteLength) {
    throw new Error("Delta patch does not reconstruct the declared target");
  }
  return out;
}

function applyDeltaPatchV2(base: Uint8Array, patch: Uint8Array): Uint8Array {
  const targetField = readVarUint(patch, 4);
  const targetSize = targetField.value;
  const countField = readVarUint(patch, targetField.next);
  const operationCount = countField.value;
  if (targetSize > DELTA_MAX_FILE_BYTES || operationCount > 1_000_000) {
    throw new Error("Delta patch dimensions are invalid");
  }
  const out = new Uint8Array(targetSize);
  let readAt = countField.next;
  let writeAt = 0;
  for (let index = 0; index < operationCount; index += 1) {
    if (readAt >= patch.byteLength) throw new Error("Delta patch is truncated");
    const opcode = patch[readAt] ?? 0xff;
    readAt += 1;
    if (opcode === 1) {
      const offsetField = readVarUint(patch, readAt);
      const lengthField = readVarUint(patch, offsetField.next);
      const offset = offsetField.value;
      const length = lengthField.value;
      if (
        length === 0 ||
        offset + length > base.byteLength ||
        writeAt + length > out.byteLength
      ) {
        throw new Error("Delta copy operation is out of bounds");
      }
      out.set(base.subarray(offset, offset + length), writeAt);
      writeAt += length;
      readAt = lengthField.next;
      continue;
    }
    if (opcode === 0) {
      const lengthField = readVarUint(patch, readAt);
      const length = lengthField.value;
      const from = lengthField.next;
      if (
        length === 0 ||
        from + length > patch.byteLength ||
        writeAt + length > out.byteLength
      ) {
        throw new Error("Delta literal operation is out of bounds");
      }
      out.set(patch.subarray(from, from + length), writeAt);
      writeAt += length;
      readAt = from + length;
      continue;
    }
    throw new Error("Delta patch contains an unknown operation");
  }
  if (readAt !== patch.byteLength || writeAt !== out.byteLength) {
    throw new Error("Delta patch does not reconstruct the declared target");
  }
  return out;
}

function uuidBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error("Delta base Version id is invalid");
  }
  const out = new Uint8Array(16);
  for (let index = 0; index < out.byteLength; index += 1) {
    out[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function digestBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Delta target digest is invalid");
  }
  const out = new Uint8Array(32);
  for (let index = 0; index < out.byteLength; index += 1) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function bytesHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function bytesUuid(bytes: Uint8Array): string {
  const value = bytesHex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Frame V2 transport metadata without JSON field names or duplicate sizes.
 *
 * The selected immutable Version and path uniquely identify the base. Its
 * digest is still checked when the signature is requested and again against
 * the stored Version while reconstructing, so repeating 32 bytes in this
 * second request adds no authority.
 */
export function encodeDeltaEnvelope(input: DeltaEnvelope): Uint8Array {
  const path = new TextEncoder().encode(input.path);
  const mediaType = new TextEncoder().encode(input.mediaType);
  if (path.byteLength === 0 || path.byteLength > 0xffff) {
    throw new Error("Delta path length is invalid");
  }
  if (mediaType.byteLength === 0 || mediaType.byteLength > 0xff) {
    throw new Error("Delta media type length is invalid");
  }
  if (input.patch.byteLength === 0) throw new Error("Delta patch is empty");
  const out = new Uint8Array(
    ENVELOPE_V2_FIXED_BYTES + path.byteLength + mediaType.byteLength + input.patch.byteLength,
  );
  out.set(ENVELOPE_MAGIC_V2, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, path.byteLength, false);
  out[6] = mediaType.byteLength;
  out.set(uuidBytes(input.baseVersionId), 7);
  out.set(digestBytes(input.sha256), 23);
  let at = ENVELOPE_V2_FIXED_BYTES;
  out.set(path, at);
  at += path.byteLength;
  out.set(mediaType, at);
  at += mediaType.byteLength;
  out.set(input.patch, at);
  return out;
}

export function isDeltaEnvelope(bytes: Uint8Array): boolean {
  return sameMagic(bytes, ENVELOPE_MAGIC_V2);
}

export function decodeDeltaEnvelope(bytes: Uint8Array): DeltaEnvelope {
  if (bytes.byteLength < ENVELOPE_V2_FIXED_BYTES + 1 || !isDeltaEnvelope(bytes)) {
    throw new Error("Delta envelope is malformed");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pathLength = view.getUint16(4, false);
  const mediaLength = bytes[6] ?? 0;
  const patchAt = ENVELOPE_V2_FIXED_BYTES + pathLength + mediaLength;
  if (pathLength === 0 || mediaLength === 0 || patchAt >= bytes.byteLength) {
    throw new Error("Delta envelope dimensions are invalid");
  }
  let path: string;
  let mediaType: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    path = decoder.decode(
      bytes.subarray(ENVELOPE_V2_FIXED_BYTES, ENVELOPE_V2_FIXED_BYTES + pathLength),
    );
    mediaType = decoder.decode(bytes.subarray(
      ENVELOPE_V2_FIXED_BYTES + pathLength,
      patchAt,
    ));
  } catch {
    throw new Error("Delta envelope text is invalid UTF-8");
  }
  return {
    baseVersionId: bytesUuid(bytes.subarray(7, 23)),
    sha256: bytesHex(bytes.subarray(23, 55)),
    path,
    mediaType,
    patch: bytes.subarray(patchAt),
  };
}

/** Frame positional V2 signatures once, without repeating paths in the reply. */
export function encodeDeltaSignatureBatch(
  signatures: Uint8Array[],
): Uint8Array {
  if (
    signatures.length === 0 ||
    signatures.length > DELTA_BATCH_MAX_FILES
  ) {
    throw new Error("Delta signature batch count is invalid");
  }
  let total = 6;
  for (const signature of signatures) {
    if (parseDeltaSignature(signature).version !== 2) {
      throw new Error("A batch may contain only V2 delta signatures");
    }
    total += 4 + signature.byteLength;
  }
  const out = new Uint8Array(total);
  out.set(SIGNATURE_BATCH_MAGIC_V2, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, signatures.length, false);
  let at = 6;
  for (const signature of signatures) {
    view.setUint32(at, signature.byteLength, false);
    at += 4;
    out.set(signature, at);
    at += signature.byteLength;
  }
  return out;
}

export function decodeDeltaSignatureBatch(bytes: Uint8Array): DeltaSignature[] {
  if (bytes.byteLength < 6 || !sameMagic(bytes, SIGNATURE_BATCH_MAGIC_V2)) {
    throw new Error("Delta signature batch is malformed");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, false);
  if (count === 0 || count > DELTA_BATCH_MAX_FILES) {
    throw new Error("Delta signature batch count is invalid");
  }
  const signatures: DeltaSignature[] = [];
  let at = 6;
  for (let index = 0; index < count; index += 1) {
    if (at + 4 > bytes.byteLength) {
      throw new Error("Delta signature batch is truncated");
    }
    const length = view.getUint32(at, false);
    at += 4;
    if (length === 0 || at + length > bytes.byteLength) {
      throw new Error("Delta signature batch member is truncated");
    }
    const signature = parseDeltaSignature(bytes.subarray(at, at + length));
    if (signature.version !== 2) {
      throw new Error("Delta signature batch contains an old signature");
    }
    signatures.push(signature);
    at += length;
  }
  if (at !== bytes.byteLength) {
    throw new Error("Delta signature batch contains trailing bytes");
  }
  return signatures;
}

/**
 * Frame several independently verifiable patches under one immutable base
 * Version. Each member keeps its own path, target digest, media type and patch;
 * only the Version id and HTTP round trip are shared.
 */
export function encodeDeltaBatchEnvelope(input: DeltaBatchEnvelope): Uint8Array {
  if (input.entries.length === 0 || input.entries.length > DELTA_BATCH_MAX_FILES) {
    throw new Error("Delta batch count is invalid");
  }
  const encoded = input.entries.map((entry) => {
    const path = new TextEncoder().encode(entry.path);
    const mediaType = new TextEncoder().encode(entry.mediaType);
    if (path.byteLength === 0 || path.byteLength > 0xffff) {
      throw new Error("Delta batch path length is invalid");
    }
    if (mediaType.byteLength === 0 || mediaType.byteLength > 0xff) {
      throw new Error("Delta batch media type length is invalid");
    }
    if (entry.patch.byteLength === 0) throw new Error("Delta batch patch is empty");
    return { entry, path, mediaType };
  });
  const total =
    22 +
    encoded.reduce(
      (sum, item) =>
        sum +
        39 +
        item.path.byteLength +
        item.mediaType.byteLength +
        item.entry.patch.byteLength,
      0,
    );
  const out = new Uint8Array(total);
  out.set(DELTA_BATCH_MAGIC_V2, 0);
  out.set(uuidBytes(input.baseVersionId), 4);
  const view = new DataView(out.buffer);
  view.setUint16(20, encoded.length, false);
  let at = 22;
  for (const item of encoded) {
    view.setUint16(at, item.path.byteLength, false);
    out[at + 2] = item.mediaType.byteLength;
    out.set(digestBytes(item.entry.sha256), at + 3);
    view.setUint32(at + 35, item.entry.patch.byteLength, false);
    at += 39;
    out.set(item.path, at);
    at += item.path.byteLength;
    out.set(item.mediaType, at);
    at += item.mediaType.byteLength;
    out.set(item.entry.patch, at);
    at += item.entry.patch.byteLength;
  }
  return out;
}

export function decodeDeltaBatchEnvelope(bytes: Uint8Array): DeltaBatchEnvelope {
  if (bytes.byteLength < 23 || !sameMagic(bytes, DELTA_BATCH_MAGIC_V2)) {
    throw new Error("Delta batch envelope is malformed");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(20, false);
  if (count === 0 || count > DELTA_BATCH_MAX_FILES) {
    throw new Error("Delta batch count is invalid");
  }
  const entries: DeltaBatchEnvelope["entries"] = [];
  const paths = new Set<string>();
  let at = 22;
  for (let index = 0; index < count; index += 1) {
    if (at + 39 > bytes.byteLength) {
      throw new Error("Delta batch member is truncated");
    }
    const pathLength = view.getUint16(at, false);
    const mediaLength = bytes[at + 2] ?? 0;
    const sha256 = bytesHex(bytes.subarray(at + 3, at + 35));
    const patchLength = view.getUint32(at + 35, false);
    at += 39;
    const pathAt = at;
    const mediaAt = pathAt + pathLength;
    const patchAt = mediaAt + mediaLength;
    const next = patchAt + patchLength;
    if (
      pathLength === 0 ||
      mediaLength === 0 ||
      patchLength === 0 ||
      next > bytes.byteLength
    ) {
      throw new Error("Delta batch member dimensions are invalid");
    }
    let path: string;
    let mediaType: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      path = decoder.decode(bytes.subarray(pathAt, mediaAt));
      mediaType = decoder.decode(bytes.subarray(mediaAt, patchAt));
    } catch {
      throw new Error("Delta batch text is invalid UTF-8");
    }
    if (paths.has(path)) throw new Error("Delta batch contains a duplicate path");
    paths.add(path);
    entries.push({
      path,
      mediaType,
      sha256,
      patch: bytes.subarray(patchAt, next),
    });
    at = next;
  }
  if (at !== bytes.byteLength) {
    throw new Error("Delta batch contains trailing bytes");
  }
  return {
    baseVersionId: bytesUuid(bytes.subarray(4, 20)),
    entries,
  };
}
