/**
 * Bringing a project down: the file list for a version, then its bytes.
 *
 * The server stores each file as a content-addressed object and serves it
 * decoded, so this writes plain bytes and verifies each one against the
 * digest the version recorded. Anything that does not match is a failure,
 * not a file quietly written wrong.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createGunzip, gunzipSync } from "node:zlib";
import path from "node:path";
import { inside, whyUnsafe } from "../shared/safe_path.js";

import type { Credentials } from "./credentials.js";
import { clientHeaders, readRefusal } from "./identify.js";
import { maybeFail } from "./faults.js";
import {
  RETRY_ATTEMPTS,
  RETRY_FIRST_WAIT_MS,
  pauseFor,
  worthRetrying,
} from "./retry.js";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** The digest of what is on disk, or null when nothing is there to read. */
async function digestOf(target: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Remove the directories a deletion just emptied, up to but never including
 * the project folder itself. Left alone they accumulate as empty husks of
 * directories the project no longer has; removed too eagerly they would take
 * a directory holding ignored files with them, so this stops at the first
 * one that still has something in it.
 */
async function pruneEmpty(root: string, removed: string): Promise<void> {
  let directory = path.dirname(removed);
  while (directory.startsWith(root) && directory !== root) {
    try {
      if ((await readdir(directory)).length) return;
      await rm(directory, { recursive: false, force: true });
    } catch {
      return;
    }
    directory = path.dirname(directory);
  }
}

export type RemoteVersion = {
  id: string;
  sequence: number;
  message: string;
  fileCount: number;
  sourceSize: number;
  createdAt: string;
  authorName: string;
  /*
    First parent first. Absent from an older service, and filtered by it to
    the versions this caller may see, so a gap means "not visible", never
    "no parent".
  */
  parentVersionIds?: string[];
};

/** One piece of a file kept in pieces, with the digest the upload recorded. */
export type RemoteChunk = {
  objectId: string;
  sha256: string;
  sourceSize: number;
};

export type RemoteFile = {
  path: string;
  /** Marked to run; restored on write everywhere but Windows. */
  executable?: boolean;
  /** The ordinary, whole-object form of this file. */
  objectId?: string;
  sha256: string;
  sourceSize: number;
  /*
    Present only for a file stored in pieces. Its presence is what routes the
    download away from asking the service to reassemble the file — which is
    what it used to do, and what silently truncated a 7.34 GB file at 5.09 GB.
  */
  chunks?: RemoteChunk[];
  /** This file's window in a decoded solid pack. */
  pack?: {
    objectId: string;
    offset: number;
    length: number;
  };
  /*
    The service holds this file covered and will hand back the real value
    only when it is asked for by path.

    So the pack and object identifiers beside this are for republishing the
    file, not for reading it. Taking the bytes out of the pack yields the
    covered copy, which then fails its check against the digest above —
    that digest describes the real file, because that is what this caller
    is entitled to be served.
  */
  sealed?: boolean;
};

export type DownloadProgress = {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  path: string;
  percent: number;
};

/**
 * How long one request may go unanswered before it is treated as lost.
 *
 * The same three minutes the uploader uses, and for the same reason: what
 * follows a deadline here is a retry, so the cost of it firing early on a
 * genuinely slow call is one repeated request.
 */
const REQUEST_DEADLINE_MS = 180_000;

/**
 * And how long a whole-version archive may take to arrive.
 *
 * The service reads every file in the version out of object storage to build
 * it, so the wait is proportional to the project rather than to the network.
 * Fifteen minutes is far beyond any archive measured and still an answer
 * rather than an indefinite wait.
 */
const ARCHIVE_DEADLINE_MS = 900_000;

/**
 * A percentage for work that is still going.
 *
 * Rounding hit 100 while files were still arriving. A project where one asset
 * is most of the bytes — which is most projects with an asset — read "100%,
 * 3 of 11" for the rest of the download, and the number people trust most is
 * the one that had stopped meaning anything. Held at 99 until the caller says
 * it is finished, and floored so it never rounds up into a lie either.
 */
export function underway(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(99, Math.floor((done / total) * 100));
}

export class DownloadCancelled extends Error {
  constructor() {
    super("Download cancelled");
  }
}

export class Downloader {
  private aborted = false;
  private readonly controller = new AbortController();

  constructor(private readonly credentials: Credentials) {}

  cancel(): void {
    this.aborted = true;
    this.controller.abort();
  }

  private check(): void {
    if (this.aborted) throw new DownloadCancelled();
  }

  /**
   * One request, repeated while repeating it might help.
   *
   * A restore makes at least one request per file and, for a file kept in
   * pieces, one per piece — three thousand seven hundred and fifty-six for a
   * single file here. At those numbers a dropped connection is not a risk but
   * a certainty, and without this the whole restore ends on the first one.
   */
  private async request(route: string): Promise<Response> {
    let wait = RETRY_FIRST_WAIT_MS;
    for (let attempt = 1; ; attempt += 1) {
      this.check();
      try {
        return await this.attempt(route);
      } catch (error) {
        // Its own cancellation first: `worthRetrying` knows nothing of it.
        if (error instanceof DownloadCancelled) throw error;
        if (attempt >= RETRY_ATTEMPTS || !worthRetrying(error)) throw error;
        try {
          await pauseFor(this.controller.signal, wait);
        } catch {
          throw new DownloadCancelled();
        }
        wait *= 2;
      }
    }
  }

  private async attempt(
    route: string,
    /*
      Longer where the service has to build the answer before it can send it.

      A deadline sized for an ordinary request aborts a large archive halfway
      through making it, and the git import quietly falls back to fetching
      every file on its own — so the fix for a slow clone became the cause of
      one. The archive for a 21,071-file version takes about ninety seconds
      to assemble and longer under load; three minutes is a request that has
      failed, not one that is still working.
    */
    deadline = REQUEST_DEADLINE_MS,
  ): Promise<Response> {
    const token = await this.credentials.token();
    if (!token) throw new Error("Sign in again before downloading");
    const response = await fetch(`${this.credentials.origin()}${route}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": "CodeRook/0.1",
        ...clientHeaders(),
      },
      /*
        The download's own cancellation, and a deadline.

        This carried only the cancel signal, so a request the service never
        answered waited for ever — the same defect that was fixed in the
        uploader and in the command line's own client, and missed here. A
        restore that stops with no bytes moving and no message is the worse
        half of it: the person is left without the thing they were restoring.
      */
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(deadline),
      ]),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      /*
        A refusal for being too old is not a network failure and must not read
        like one: the person can fix it, and only if they are told how.
      */
      const tooOld = readRefusal(response.status, text);
      if (tooOld) {
        throw new Error(
          `${tooOld.message} You are running ${tooOld.yourVersion ?? "an older build"}; ` +
            `update from ${tooOld.upgradeUrl}.`,
        );
      }
      let message = `${route} failed (${response.status})`;
      let code: string | undefined;
      try {
        const body = JSON.parse(text);
        message = body?.error?.message ?? message;
        code = body?.error?.code;
      } catch {
        /* the body was not JSON; the status will have to do */
      }
      /*
        The status travels with the error.

        Callers already reason about it — the retry rule asks whether a
        failure is worth trying again, and the sync asks whether a project is
        gone or merely unreachable — and both were reading a property that
        was never set. A plain Error made every failure look identical, so a
        404 for a deleted project was retried five times and then reported as
        though the network were down.
      */
      throw Object.assign(new Error(message), { status: response.status, code });
    }
    return response;
  }

  /**
   * Read a complete JSON response under the same retry rule as the request.
   *
   * `fetch()` resolves as soon as the headers arrive. A connection can still
   * disappear while `.json()` is consuming the body; treating the response
   * object as success meant a large file list failed outside the retry loop.
   * These routes are reads, so repeating the whole request is safe and is the
   * only way to replace a truncated body.
   */
  private async json<T>(route: string): Promise<T> {
    let wait = RETRY_FIRST_WAIT_MS;
    for (let attempt = 1; ; attempt += 1) {
      this.check();
      try {
        return await (await this.attempt(route)).json() as T;
      } catch (error) {
        if (error instanceof DownloadCancelled) throw error;
        if (attempt >= RETRY_ATTEMPTS || !worthRetrying(error)) throw error;
        try {
          await pauseFor(this.controller.signal, wait);
        } catch {
          throw new DownloadCancelled();
        }
        wait *= 2;
      }
    }
  }

  async versions(repositoryId: string): Promise<RemoteVersion[]> {
    const body = await this.json<{ versions?: Array<Record<string, unknown>> }>(
      `/v1/repositories/${repositoryId}/versions`,
    );
    return (body.versions ?? []).map((row) => ({
      id: String(row.id ?? ""),
      sequence: Number(row.sequence ?? 0),
      message: String(row.message ?? ""),
      fileCount: Number(row.fileCount ?? 0),
      sourceSize: Number(row.sourceSize ?? 0),
      createdAt: String(row.createdAt ?? ""),
      /* The service sends `author.displayName`; `authorName` was never filled. */
      authorName: String(
        row.authorName ?? (row.author as { displayName?: string } | undefined)?.displayName ?? "",
      ),
      ...(Array.isArray(row.parentVersionIds)
        ? { parentVersionIds: row.parentVersionIds.map((id) => String(id)) }
        : {}),
    }));
  }

  /**
   * A whole version as one archive, for a caller that wants all of it.
   *
   * The git import asked for each file in its own request, which on a
   * 21,071-file project is 21,071 round trips — four hours in series, and
   * about half an hour even eight at a time. The service already builds the
   * whole version as a single stored archive for the download button; this
   * is that, for a caller that would otherwise ask file by file.
   *
   * Returned whole rather than streamed because the caller is handing the
   * files to `git fast-import`, which wants them one after another anyway.
   */
  async archive(repositoryId: string, versionId: string): Promise<Uint8Array> {
    const response = await this.attempt(
      `/v1/repositories/${repositoryId}/versions/${versionId}/archive`,
      ARCHIVE_DEADLINE_MS,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async files(repositoryId: string, versionId: string): Promise<RemoteFile[]> {
    const body = await this.json<{ files?: Array<Record<string, unknown>> }>(
      `/v1/repositories/${repositoryId}/versions/${versionId}/files`,
    );
    return (body.files ?? []).map((row) => {
      const pieces = Array.isArray(row.chunks) ? row.chunks : null;
      const packed =
        row.pack && typeof row.pack === "object"
          ? (row.pack as Record<string, unknown>)
          : null;
      return {
        path: String(row.path ?? ""),
        ...(row.objectId ? { objectId: String(row.objectId) } : {}),
        sha256: String(row.sha256 ?? ""),
        sourceSize: Number(row.sourceSize ?? 0),
        ...(row.executable === true ? { executable: true } : {}),
        ...(row.sealed === true ? { sealed: true } : {}),
        ...(packed?.objectId
          ? {
              pack: {
                objectId: String(packed.objectId),
                offset: Number(packed.offset ?? 0),
                length: Number(packed.length ?? 0),
              },
            }
          : {}),
        ...(pieces && pieces.length
          ? {
              chunks: pieces.map((piece) => {
                const one = piece as Record<string, unknown>;
                return {
                  objectId: String(one.objectId ?? ""),
                  sha256: String(one.sha256 ?? ""),
                  sourceSize: Number(one.sourceSize ?? 0),
                };
              }),
            }
          : {}),
      };
    });
  }

  /**
   * Fetch one file to `target`, verifying it as it lands, and answer with the
   * digest of what was actually written.
   *
   * A file kept in pieces is fetched piece by piece and assembled here rather
   * than by the service. That is the whole point of this method. Asking the
   * service to hand back one reassembled file made it loop over every piece
   * inside a single edge invocation, and for a file of three thousand seven
   * hundred and fifty-six pieces it ran out of whatever it runs out of and
   * stopped — after the two hundred and its headers had already gone out. A
   * 7.34 GB file came back as 5.09 GB under a clean `200`, with nothing in
   * the response saying otherwise. Pulling the pieces from here bounds each
   * request to one piece and puts the loop somewhere that can fail honestly.
   *
   * Nothing is held whole. The previous version read the entire file into one
   * buffer to hash it, which for this file would have been 7.34 GB resident
   * before the check it was there to perform could even run.
   */
  /**
   * Fetch one file from a version to a chosen path, verified, and answer with
   * the digest of what was written.
   *
   * Restoring a whole version is the usual case. This is the same machinery
   * for somebody who wants one file out of one — and it is how a very large
   * file can be checked on its own, without pulling down the project it
   * belongs to in order to find out whether it survives the trip.
   */
  async fileTo(
    repositoryId: string,
    versionId: string,
    file: RemoteFile,
    target: string,
  ): Promise<string> {
    await mkdir(path.dirname(target), { recursive: true });
    const digest = await this.fetchInto(repositoryId, versionId, file, target);
    await applyMode(target, file.executable === true);
    return digest;
  }

  /**
   * Reconstruct and verify every file in a Version without materialising the
   * whole project at once. Solid packs are fetched once and large files use a
   * single reusable scratch path, so the disk requirement is bounded by the
   * largest individual file rather than the complete snapshot.
   */
  async verify(
    repositoryId: string,
    versionId: string,
    scratch: string,
    report: (progress: DownloadProgress) => void,
  ): Promise<{ files: number; bytes: number; manifest: Record<string, string> }> {
    const files = await this.files(repositoryId, versionId);
    if (!files.length) throw new Error("That version has no files");
    const totalBytes = files.reduce((total, file) => total + file.sourceSize, 0);
    const packed = new Map<string, RemoteFile[]>();
    for (const file of files) {
      const id = file.pack?.objectId;
      if (!id || file.sealed) continue;
      const group = packed.get(id) ?? [];
      group.push(file);
      packed.set(id, group);
    }

    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    const temporary = path.join(scratch, "current-file.partial");
    const restoredPacks = new Set<string>();
    const manifest: Record<string, string> = {};
    let written = 0;
    let bytes = 0;
    const progress = (filePath: string) => report({
      files: written,
      totalFiles: files.length,
      bytes,
      totalBytes,
      path: filePath,
      percent: underway(bytes, totalBytes),
    });

    try {
      for (const file of files) {
        this.check();
        progress(file.path);
        const packId = file.sealed ? undefined : file.pack?.objectId;
        if (packId && restoredPacks.has(packId)) continue;
        if (packId) {
          const reply = await this.request(
            `/v1/repositories/${repositoryId}/objects/${packId}`,
          );
          const body = Buffer.from(await reply.arrayBuffer());
          const packDigest = createHash("sha256").update(body).digest("hex");
          const expectedPackDigest = reply.headers.get("x-coderook-sha256");
          if (expectedPackDigest && packDigest !== expectedPackDigest) {
            throw new Error("A solid pack did not arrive intact");
          }
          for (const member of packed.get(packId) ?? []) {
            const offset = member.pack!.offset;
            const length = member.pack!.length;
            if (offset < 0 || length < 0 || offset + length > body.byteLength) {
              throw new Error(`${member.path} points outside its solid pack`);
            }
            const digest = createHash("sha256")
              .update(body.subarray(offset, offset + length))
              .digest("hex");
            if (member.sha256 && digest !== member.sha256) {
              throw new Error(`${member.path} did not arrive intact`);
            }
            manifest[member.path] = digest;
            written += 1;
            bytes += member.sourceSize;
            progress(member.path);
          }
          restoredPacks.add(packId);
          continue;
        }

        const digest = await this.fetchInto(repositoryId, versionId, file, temporary);
        if (file.sha256 && digest !== file.sha256) {
          throw new Error(`${file.path} did not arrive intact`);
        }
        manifest[file.path] = digest;
        written += 1;
        bytes += file.sourceSize;
        await rm(temporary, { force: true });
      }
      progress("Done");
      return { files: written, bytes, manifest };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Hand each of `files` to `visit`, verified, without writing a folder.
   *
   * For a caller that keeps files somewhere of its own: the local history
   * stores them as objects. A solid pack is fetched once and its members
   * handed over as bytes; anything else arrives at `scratch` first, so a
   * large file is never held in memory, and is gone before the next one.
   */
  async collect(
    repositoryId: string,
    versionId: string,
    files: RemoteFile[],
    scratch: string,
    visit: (file: RemoteFile, arrived: { bytes: Buffer } | { path: string }) => Promise<void>,
  ): Promise<void> {
    await mkdir(scratch, { recursive: true });
    const temporary = path.join(scratch, "arriving.partial");
    const packs = new Map<string, RemoteFile[]>();
    const single: RemoteFile[] = [];
    for (const file of files) {
      const id = file.sealed ? undefined : file.pack?.objectId;
      if (!id) {
        single.push(file);
        continue;
      }
      const group = packs.get(id) ?? [];
      group.push(file);
      packs.set(id, group);
    }
    try {
      for (const [packId, members] of packs) {
        this.check();
        const reply = await this.request(`/v1/repositories/${repositoryId}/objects/${packId}`);
        const body = Buffer.from(await reply.arrayBuffer());
        const expected = reply.headers.get("x-coderook-sha256");
        if (expected && createHash("sha256").update(body).digest("hex") !== expected) {
          throw new Error("A solid pack did not arrive intact");
        }
        for (const member of members) {
          const { offset, length } = member.pack!;
          if (offset < 0 || length < 0 || offset + length > body.byteLength) {
            throw new Error(`${member.path} points outside its solid pack`);
          }
          const bytes = Buffer.from(body.subarray(offset, offset + length));
          if (createHash("sha256").update(bytes).digest("hex") !== member.sha256) {
            throw new Error(`${member.path} did not arrive intact`);
          }
          await visit(member, { bytes });
        }
      }
      for (const file of single) {
        this.check();
        const digest = await this.fetchInto(repositoryId, versionId, file, temporary);
        if (digest !== file.sha256) throw new Error(`${file.path} did not arrive intact`);
        await visit(file, { path: temporary });
        await rm(temporary, { force: true });
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /*
    Paths whose bytes arrived still gzip-compressed and were recovered.

    A service that recorded an object's encoding wrongly served its stored
    gzip as though it were the file (found on CodeRook in September 2026; the
    service now judges the encoding from the stored size). The bytes were
    never damaged, only still compressed, so a body that fails its digest,
    starts with gzip's magic number and decompresses to exactly the expected
    digest is accepted. Anything else still fails. Listed here so a caller
    can say it happened.
  */
  readonly recoveredFromGzip: string[] = [];

  private async fetchInto(
    repositoryId: string,
    versionId: string,
    file: RemoteFile,
    target: string,
  ): Promise<string> {
    const whole = createHash("sha256");
    /*
      A sealed file is read whole, by path, whatever shape it is stored in.

      Its pieces and its object are the covered bytes; only the per-path route
      puts the real value back. Reading it any other way fetches something
      that cannot match the digest this file was listed with.
    */
    const pieces = file.sealed ? [] : (file.chunks ?? []);
    let recovered = false;
    // Captured so the generators below do not need `this` rebound.
    const request = (route: string) => this.request(route);
    const check = () => this.check();

    const source = pieces.length
      ? (async function* () {
          for (let at = 0; at < pieces.length; at += 1) {
            check();
            const piece = pieces[at]!;
            const reply = await request(
              `/v1/repositories/${repositoryId}/objects/${piece.objectId}`,
            );
            let body: Buffer = Buffer.from(await reply.arrayBuffer());
            /*
              Checked against what the upload recorded for this piece, before
              a byte of it reaches the file. Without the digest the only
              available check was the whole file's, which says that something
              in seven gigabytes is wrong and nothing about what.
            */
            const digest = createHash("sha256").update(body).digest("hex");
            if (piece.sha256 && digest !== piece.sha256) {
              const plain = gunzippedMatching(body, piece.sha256);
              if (!plain) {
                throw new Error(
                  `${file.path}: piece ${at + 1} of ${pieces.length} ` +
                    `did not arrive intact`,
                );
              }
              recovered = true;
              body = plain;
            }
            whole.update(body);
            yield body;
          }
        })()
      : (async function* () {
          const reply = await request(
            file.objectId && !file.sealed
              ? `/v1/repositories/${repositoryId}/objects/${file.objectId}`
              : `/v1/repositories/${repositoryId}/versions/${versionId}/file` +
                  `?path=${encodeURIComponent(file.path)}`,
          );
          if (!reply.body) return;
          for await (const block of Readable.fromWeb(
            reply.body as Parameters<typeof Readable.fromWeb>[0],
          )) {
            check();
            const buffer = Buffer.from(block as Uint8Array);
            whole.update(buffer);
            yield buffer;
          }
        })();

    /*
      `pipeline` rather than a write loop: it applies backpressure, and it
      destroys the file handle when the source throws. A partially written
      file left open on a failed verification is how a staging directory ends
      up holding something that looks finished.
    */
    await pipeline(source, createWriteStream(target));
    const digest = whole.digest("hex");
    if (recovered) this.recoveredFromGzip.push(file.path);
    if (!pieces.length && file.sha256 && digest !== file.sha256) {
      if (await recoverGzipFile(target, file.sha256)) {
        this.recoveredFromGzip.push(file.path);
        return file.sha256;
      }
    }
    return digest;
  }

  /**
   * Write a version into `destination`.
   *
   * Files land in a staging directory and are put in place only once every
   * one has arrived and verified, so a failed download never leaves a
   * half-project behind.
   *
   * What is put in place is the version's files, one at a time — not the
   * whole directory. Replacing the directory wholesale also removes
   * everything the version deliberately does not contain: the dependencies,
   * the local credentials, the unfinished work and the git repository
   * itself. A file the version no longer holds is removed only when this
   * folder is known to have received it, which `held` supplies.
   */
  async run(
    repositoryId: string,
    versionId: string,
    destination: string,
    report: (progress: DownloadProgress) => void,
    held?: Record<string, string> | null,
    /*
      `reconcile` brings the folder up to date without disturbing work in
      progress: a file the incoming version did not change is left exactly as
      it is, edits and all. `replace` makes the folder an exact copy of the
      version, which is what repairs a damaged one — and what discards
      anything unsaved.
    */
    mode: "reconcile" | "replace" = "replace",
  ): Promise<{ files: number; bytes: number; manifest: Record<string, string> }> {
    const files = await this.files(repositoryId, versionId);
    if (!files.length) throw new Error("That version has no files");
    const totalBytes = files.reduce((total, file) => total + file.sourceSize, 0);
    const staging = `${destination}.incoming`;
    await rm(staging, { recursive: true, force: true });
    const manifest: Record<string, string> = {};

    try {
      let written = 0;
      let bytes = 0;
      const packed = new Map<string, RemoteFile[]>();
      for (const file of files) {
        /* Sealed members never come out of the pack — see `sealed` above. */
        const id = file.sealed ? undefined : file.pack?.objectId;
        if (!id) continue;
        const group = packed.get(id) ?? [];
        group.push(file);
        packed.set(id, group);
      }
      const restoredPacks = new Set<string>();
      /*
        Fetched several at a time, and each pack fetched once.

        This was one request after another — a pack or a file, wait for it,
        write it, ask for the next — while the sending side has had six lanes
        for a long time. Measured across thirty project shapes, that made
        restoring roughly six times slower than saving the same bytes: an
        Unreal project of four hundred and ninety megabytes went up in ten
        minutes and came back in sixty-one. A restore is mostly waiting on the
        network, and waiting is the thing that overlaps.

        The work is planned before any of it runs, which also removes the
        double-fetch guard the serial version needed: a pack appears once in
        the list, so it can only be fetched once.
      */
      const jobs: Array<
        { kind: "pack"; id: string } | { kind: "file"; file: (typeof files)[number] }
      > = [];
      for (const file of files) {
        const id = file.sealed ? undefined : file.pack?.objectId;
        if (id) {
          if (restoredPacks.has(id)) continue;
          restoredPacks.add(id);
          jobs.push({ kind: "pack", id });
        } else {
          jobs.push({ kind: "file", file });
        }
      }

      /*
        Every path checked before a byte is fetched, so a version carrying one
        it must not write is refused whole rather than half-written. The check
        used to refuse `..` alone, which let `.git/config` through to be
        renamed over a checkout's real one — see shared/safe_path.ts.
      */
      for (const file of files) {
        const reason = whyUnsafe(file.path);
        if (reason) {
          throw new Error(`That version contains an unsafe path (${reason}): ${file.path}`);
        }
      }

      const told = { at: 0 };
      const sayProgress = (where: string) => {
        const now = Date.now();
        if (now - told.at < 80) return;
        told.at = now;
        report({
          files: written,
          totalFiles: files.length,
          bytes,
          totalBytes,
          path: where,
          percent: underway(bytes, totalBytes),
        });
      };

      const restorePack = async (packId: string): Promise<void> => {
        /*
          A solid pack is one compressed object containing many small files.

          Asking the single-file route for every member made a large restore
          fetch and decompress the same pack thousands of times. The files
          listing already gives us the pack id and each member's exact window,
          so fetch the decoded pack once, verify it, and materialise every
          member before releasing the buffer.
        */
        const reply = await this.request(
          `/v1/repositories/${repositoryId}/objects/${packId}`,
        );
        const body = Buffer.from(await reply.arrayBuffer());
        const packDigest = createHash("sha256").update(body).digest("hex");
        const expectedPackDigest = reply.headers.get("x-coderook-sha256");
        if (expectedPackDigest && packDigest !== expectedPackDigest) {
          throw new Error("A solid pack did not arrive intact");
        }
        for (const member of packed.get(packId) ?? []) {
          this.check();
          const offset = member.pack!.offset;
          const length = member.pack!.length;
          if (offset < 0 || length < 0 || offset + length > body.byteLength) {
            throw new Error(`${member.path} points outside its solid pack`);
          }
          const contents = body.subarray(offset, offset + length);
          const digest = createHash("sha256").update(contents).digest("hex");
          if (member.sha256 && digest !== member.sha256) {
            throw new Error(`${member.path} did not arrive intact`);
          }
          const full = inside(staging, member.path);
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, contents);
          manifest[member.path] = digest;
          written += 1;
          bytes += member.sourceSize;
          sayProgress(member.path);
        }
      };

      const restoreFile = async (file: (typeof files)[number]): Promise<void> => {
        const full = inside(staging, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        const digest = await this.fetchInto(repositoryId, versionId, file, full);
        /*
          The whole file's digest, checked after every piece has already been
          checked individually. Both are needed: the pieces catch a corrupt or
          truncated piece and name it, and this catches a set of individually
          valid pieces assembled in the wrong order or with one missing —
          which is the failure that produces bytes that are all present, all
          verified, and wrong.
        */
        if (file.sha256 && digest !== file.sha256) {
          throw new Error(`${file.path} did not arrive intact`);
        }
        manifest[file.path] = digest;
        written += 1;
        bytes += file.sourceSize;
        sayProgress(file.path);
      };

      /*
        Bounded by bytes in flight, not by how many files are open.

        Six lanes turned an hour-long restore of many small files into a
        minute, and made a restore of three very large ones eight times
        slower — 93 seconds became 802. Splitting the queue by file size
        fixed that shape and cost another: a project of forty-megabyte video
        files had its six big ones running two at a time while the small ones
        finished and left the line idle, and its fetch went from 54 seconds
        to 151.

        Neither is really about file count. A file is fetched a piece at a
        time, so each job holds exactly one request open whatever its size —
        what six large files at once actually costs is six streams' worth of
        bytes being buffered, hashed and written against one line. So that is
        what is bounded: lanes take work while the bytes already in flight
        leave room for it. Forty-megabyte files then run five or six at a
        time and hundred-megabyte ones run two, without a threshold having to
        guess which project this is.
      */
      const LANES = 6;
      const BYTES_IN_FLIGHT = 200 * 1024 * 1024;
      const sizeOf = (job: (typeof jobs)[number]) =>
        job.kind === "pack" ? 0 : job.file.sourceSize;

      let next = 0;
      let flying = 0;
      /*
        Every waiting lane, not the most recent one. A single slot would let a
        second waiter overwrite the first, and the first would then never be
        woken — a restore that stops with lanes idle and work left.
      */
      const waiting: Array<() => void> = [];
      const wakeAll = () => {
        while (waiting.length) waiting.pop()!();
      };
      const roomFor = async (size: number): Promise<void> => {
        /*
          One job always proceeds, however large. A file bigger than the whole
          budget would otherwise wait for room that can never appear.
        */
        while (flying > 0 && flying + size > BYTES_IN_FLIGHT) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
          });
        }
      };
      const lane = async (): Promise<void> => {
        for (;;) {
          const at = next;
          next += 1;
          if (at >= jobs.length) return;
          this.check();
          const job = jobs[at]!;
          const size = sizeOf(job);
          await roomFor(size);
          flying += size;
          try {
            if (job.kind === "pack") await restorePack(job.id);
            else await restoreFile(job.file);
          } finally {
            flying -= size;
            wakeAll();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(LANES, jobs.length) }, () => lane()),
      );

      /*
        Everything has arrived and verified, so it can go into place. Each
        file is renamed over its destination individually: a rename within
        one volume is atomic, so no file is ever seen half-written, and
        anything the version does not mention is left exactly as it is.
      */
      // Everything has arrived and verified; the folder is still untouched.
      maybeFail("get:after-staging");

      await mkdir(destination, { recursive: true });
      let placed = 0;
      for (const file of files) {
        const target = inside(destination, file.path);
        /*
          Reconciling leaves alone whatever the incoming version did not
          change. Writing it anyway would replace an edit in progress with a
          copy of what the folder already had — destroying work to achieve
          nothing, which is the least defensible way to lose someone's file.
        */
        if (
          mode === "reconcile" &&
          held &&
          held[file.path] === manifest[file.path] &&
          (await exists(target))
        ) {
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        await rm(target, { recursive: true, force: true });
        await rename(inside(staging, file.path), target);
        await applyMode(target, file.executable === true);
        placed += 1;
        if (placed === 1) maybeFail("get:after-first-file");
      }

      /*
        A file this folder received but the version no longer holds is gone
        deliberately, so it goes. One it never received is not this fetch's
        to remove — and without a record of what it received, nothing is
        removed at all, which is the safe reading of an unknown folder.
      */
      for (const [gone, digest] of Object.entries(held ?? {})) {
        if (manifest[gone] !== undefined) continue;
        /* A path it must not write is not one it may delete either. */
        if (whyUnsafe(gone)) continue;
        const target = inside(destination, gone);
        /*
          The version dropped it — but if the bytes here are no longer the
          ones this folder received, somebody has been working on it, and
          somebody else's deletion is not permission to throw that away.
        */
        if (mode === "reconcile" && (await digestOf(target)) !== digest) continue;
        await rm(target, { force: true });
        await pruneEmpty(destination, target);
        maybeFail("get:after-delete");
      }

      // The folder is now the new version; nothing has recorded that yet.
      maybeFail("get:before-record");

      await rm(staging, { recursive: true, force: true });
      report({
        files: written,
        totalFiles: files.length,
        bytes,
        totalBytes,
        path: "Done",
        percent: 100,
      });
      return { files: written, bytes, manifest };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

/** The gunzipped bytes when they hash to `expected`, otherwise null. */
function gunzippedMatching(body: Buffer, expected: string): Buffer | null {
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return null;
  try {
    const plain = gunzipSync(body);
    return createHash("sha256").update(plain).digest("hex") === expected ? plain : null;
  } catch {
    return null;
  }
}

/**
 * Replace a file that arrived still gzip-compressed with its contents, when
 * those contents hash to `expected`. Streamed, so a large file is never held.
 */
async function recoverGzipFile(target: string, expected: string): Promise<boolean> {
  const handle = await open(target, "r");
  const magic = Buffer.alloc(2);
  try {
    await handle.read(magic, 0, 2, 0);
  } finally {
    await handle.close();
  }
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return false;
  const temporary = `${target}.gunzip`;
  const hash = createHash("sha256");
  try {
    await pipeline(
      createReadStream(target),
      createGunzip(),
      new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk as Buffer);
          done(null, chunk);
        },
      }),
      createWriteStream(temporary),
    );
  } catch {
    await rm(temporary, { force: true });
    return false;
  }
  if (hash.digest("hex") !== expected) {
    await rm(temporary, { force: true });
    return false;
  }
  await rename(temporary, target);
  return true;
}

/**
 * Give a written file the execute bit its version records, or take it away.
 *
 * Windows has no execute bit, so nothing is done there. Elsewhere a script
 * that came back as an ordinary file could not be run until somebody noticed
 * and ran chmod, which on Linux was every shell script in every clone.
 */
export async function applyMode(target: string, executable: boolean): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(target, executable ? 0o755 : 0o644);
  } catch {
    /* A file that cannot take a mode is still the right file. */
  }
}
