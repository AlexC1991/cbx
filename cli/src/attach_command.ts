/**
 * `cbx attach` — put a file people can download on a version.
 *
 * A version could already hold downloads and there was no way to add one. The
 * service accepted an attachment naming any object already on the project,
 * and the only thing that ever put an object there through this door was a
 * workflow run — so shipping a build made anywhere else meant a person
 * clicking through the website, and shipping one built on this machine meant
 * nothing at all.
 *
 * The size is the interesting part. A single PUT is capped at 95 MiB by the
 * service, and the installer this was written for is 95.5 MB — so the
 * comfortable path is the one that does not work for the thing people most
 * want to attach. Anything above the cap goes up in parts instead, which is
 * the same route the desktop uploader uses.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import { attachToVersion, beginUpload, completeUpload, putObject, uploadPart } from "./api.js";
import { resolveProject } from "./project_commands.js";
import { split } from "./version_commands.js";
import { versions } from "./api.js";

import type { Parsed } from "./registry.js";

const dim = (value: string) => `[2m${value}[0m`;
const bold = (value: string) => `[1m${value}[0m`;
const red = (value: string) => `[31m${value}[0m`;
const green = (value: string) => `[32m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;

/** What the service will take in one request. */
const DIRECT_LIMIT = 95 * 1024 * 1024;
/** Comfortably under the cap, so one slow part does not hold the rest up. */
const PART_SIZE = 32 * 1024 * 1024;

function readable(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The digest, read a piece at a time.
 *
 * A ninety-five megabyte installer read into memory to be hashed and then
 * read again to be sent is two hundred megabytes of a small machine's memory
 * spent saying something a stream can say for nothing.
 */
async function digestOf(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (piece) => hash.update(piece));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

/** A media type from the name, because the service records one either way. */
function mediaTypeOf(name: string): string {
  const known: Record<string, string> = {
    ".exe": "application/vnd.microsoft.portable-executable",
    ".dmg": "application/x-apple-diskimage",
    ".deb": "application/vnd.debian.binary-package",
    ".rpm": "application/x-rpm",
    ".appimage": "application/x-executable",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tgz": "application/gzip",
    ".7z": "application/x-7z-compressed",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
  };
  return known[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Send the bytes and return the object they became.
 *
 * Two routes, one answer. Which one is used is a property of the size and not
 * something a caller should have to think about, so it is decided here.
 */
async function sendFile(
  repositoryId: string,
  file: string,
  size: number,
  sha256: string,
  mediaType: string,
  say: (text: string) => void,
): Promise<string> {
  if (size <= DIRECT_LIMIT) {
    const handle = await open(file, "r");
    try {
      const bytes = await handle.readFile();
      return await putObject(repositoryId, sha256, bytes, mediaType);
    } finally {
      await handle.close();
    }
  }

  /*
    Parts, because the service will not take this in one request. Sent one at
    a time rather than at once: the point of this path is a file too big to
    hold comfortably, and holding four of its pieces to go faster gives that
    back.
  */
  const session = await beginUpload(repositoryId, {
    sha256,
    size,
    mediaType,
    kind: "chunk",
    repositoryRole: "chunk",
  });
  const parts = Math.ceil(size / PART_SIZE);
  say(dim(`  ${readable(size)} in ${parts} parts`));
  const handle = await open(file, "r");
  try {
    for (let index = 0; index < parts; index += 1) {
      const start = index * PART_SIZE;
      const length = Math.min(PART_SIZE, size - start);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      await uploadPart(session.uploadSessionId, index + 1, buffer);
      say(dim(`  part ${index + 1}/${parts}`));
    }
  } finally {
    await handle.close();
  }
  return await completeUpload(session.uploadSessionId);
}

export async function commandAttach(parsed: Parsed): Promise<number> {
  const file = parsed.positional[0];
  if (!file) {
    console.error(
      red("Which file?") + dim("  cbx attach ./release/Installer.exe"),
    );
    return 1;
  }

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      console.error(red(`${file} is not a file.`));
      return 1;
    }
    size = info.size;
  } catch {
    console.error(red(`There is no file at ${file}.`));
    return 1;
  }
  if (size === 0) {
    console.error(red("That file is empty."));
    return 1;
  }

  /*
    The version is the second positional, so `cbx attach build.exe 41` reads
    the way the other version commands do. Without one it is the newest save,
    which is almost always the one just built against.
  */
  const which = split({
    ...parsed,
    positional: parsed.positional.slice(1),
  } as Parsed);
  const project = await resolveProject(which.project);
  if (!project) return 1;

  const all = await versions(project.id);
  if (!all.length) {
    console.error(red("This project has no versions yet."));
    return 1;
  }
  const target = which.n
    ? all.find((one) => String(one.sequence) === which.n!.replace(/^v/i, ""))
    : all.reduce((newest, one) => (one.sequence > newest.sequence ? one : newest));
  if (!target) {
    console.error(red(`This project has no version ${which.n}.`));
    return 1;
  }

  const named = parsed.flags.get("name");
  const name = typeof named === "string" && named.trim() ? named.trim() : path.basename(file);

  console.log(
    `${bold(name)} ${dim(`(${readable(size)})`)} → ${accent(`v${target.sequence}`)} of ${project.name}`,
  );

  let objectId: string;
  try {
    const sha256 = await digestOf(file);
    objectId = await sendFile(
      project.id,
      file,
      size,
      sha256,
      mediaTypeOf(name),
      (text) => console.log(text),
    );
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  try {
    await attachToVersion(project.id, target.id, name, objectId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(message));
    if (/already has something called/i.test(message)) {
      console.error(
        dim("  Use --name to give this one a different name on the version."),
      );
    }
    return 1;
  }

  console.log(green(`Attached. It is a download on v${target.sequence}.`));
  if (!target.name) {
    /*
      Said because it is the difference between attaching and publishing. A
      commit is not offered to anybody, so the download exists and nobody
      outside the project can reach it yet.
    */
    console.log(
      dim("  v") +
        dim(String(target.sequence)) +
        dim(" is a commit, so nobody outside the project can take it yet."),
    );
    console.log(dim(`  Make it a version: cbx mark ${target.sequence} --name v1.0`));
  }
  return 0;
}
