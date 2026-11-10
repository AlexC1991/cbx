/**
 * `cbx restore` in a folder linked to a CodeRook project.
 *
 * `restore` used to know only the local history (`cbx init` and `cbx save`),
 * so in a folder made by `cbx clone` or `cbx link`, the kind nearly everyone
 * has, it answered "No history here" while `cbx log` beside it worked.
 * The folder does have a history; it lives on CodeRook. This puts files back
 * the way a saved Version had them, by default the Version the folder is on.
 *
 * Same rules as the local restore:
 * - an unsaved edit to a file it would overwrite stops it, listed, unless
 *   --force is given;
 * - files the Version does not hold are left alone;
 * - the folder's link does not move, so `cbx submit` afterwards saves the
 *   folder as it now is, and `cbx get` still sees restored-from-older files
 *   as edits rather than silently overwriting them.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import process from "node:process";

import { Downloader, type RemoteFile } from "../../cbx/src/core/download.js";
import { whyUnsafe } from "../../cbx/src/shared/safe_path.js";
import { credentials, readLink, type Link } from "./config.js";
import type { Parsed } from "./registry.js";

const ESC = String.fromCharCode(27);
const paint = (code: string) => (value: string) => `${ESC}[${code}m${value}${ESC}[0m`;
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const accent = paint("33");
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

async function digestOfFile(full: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const block of createReadStream(full)) hash.update(block as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** The linked folder this directory is in, walking up as `git` does. */
export async function linkedRoot(from: string): Promise<{ root: string; link: Link } | null> {
  let at = path.resolve(from);
  for (;;) {
    const link = await readLink(at);
    if (link) return { root: at, link };
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

/** Project paths a restore covers: the named files and everything under named folders. */
export function selectFiles(files: RemoteFile[], wanted: string[]): RemoteFile[] {
  if (!wanted.length) return files;
  return files.filter((file) =>
    wanted.some((one) => one === "" || file.path === one || file.path.startsWith(`${one}/`)),
  );
}

/** A path typed on the command line, as a path inside the project ("" for the root). */
export function projectPath(root: string, cwd: string, typed: string): string | null {
  const relative = path.relative(root, path.resolve(cwd, typed));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/").replace(/\/+$/, "");
}

export async function commandRemoteRestore(parsed: Parsed): Promise<number> {
  const found = await linkedRoot(process.cwd());
  if (!found) {
    console.error(red("No history here."));
    console.error(
      dim("  This folder is not linked to a CodeRook project and has no local history. ") +
        accent("cbx link <project>") + dim(" connects it; ") + accent("cbx init") +
        dim(" starts a history on this machine."),
    );
    return 1;
  }
  const { root, link } = found;
  const force = parsed.flags.has("force") || parsed.flags.has("f");

  const wanted: string[] = [];
  for (const typed of parsed.positional) {
    const one = projectPath(root, process.cwd(), typed);
    if (one === null) {
      console.error(red(`${typed} is outside the project folder (${root}).`));
      return 1;
    }
    wanted.push(one);
  }

  const downloader = new Downloader(credentials);
  const versions = await downloader.versions(link.repositoryId);
  const from = parsed.flags.get("from");
  let version;
  if (typeof from === "string") {
    const sequence = /^v?(\d+)$/i.exec(from.trim());
    version = sequence
      ? versions.find((one) => one.sequence === Number(sequence[1]))
      : versions.find((one) => one.id.startsWith(from.trim()));
    if (!version) {
      console.error(red(`No version ${from} in ${link.slug}.`) + dim(" cbx versions lists them."));
      return 1;
    }
  } else {
    const base = link.baseVersionId ?? link.versionId;
    version =
      versions.find((one) => one.id === base) ??
      versions.find((one) => one.sequence === link.sequence);
    if (!version) {
      console.error(
        red("This folder's saved version could not be found.") +
          dim(" Name one with --from vN."),
      );
      return 1;
    }
  }

  const files = selectFiles(await downloader.files(link.repositoryId, version.id), wanted);
  if (!files.length) {
    console.error(
      red(`v${version.sequence} holds nothing at ${wanted.join(", ") || "the project root"}.`),
    );
    return 1;
  }

  const toWrite: RemoteFile[] = [];
  const edited: string[] = [];
  for (const file of files) {
    const unsafe = whyUnsafe(file.path);
    if (unsafe) {
      console.error(red(`Skipped ${JSON.stringify(file.path)}: ${unsafe}.`));
      continue;
    }
    const here = await digestOfFile(path.join(root, ...file.path.split("/")));
    if (here === file.sha256) continue;
    /*
      Different from the version. If it still matches what CodeRook last placed
      here, it is only an older or newer copy and may be replaced. Otherwise it
      is somebody's unsaved work, and that needs --force.
    */
    const placed = link.local?.[file.path];
    if (here !== null && here !== placed && !force) edited.push(file.path);
    toWrite.push(file);
  }

  if (edited.length) {
    console.error(
      red(`${plural(edited.length, "file")} here ${edited.length === 1 ? "has" : "have"} ` +
        `unsaved changes that restoring would overwrite:`),
    );
    for (const one of edited.slice(0, 20)) console.error(`  ${one}`);
    if (edited.length > 20) console.error(dim(`  …and ${edited.length - 20} more`));
    console.error(`\nAdd ${accent("--force")} to discard them, or save them first with ${accent("cbx submit")}.`);
    return 1;
  }
  if (!toWrite.length) {
    console.log(`Already matches ${accent(`v${version.sequence}`)}; nothing to put back.`);
    return 0;
  }

  for (const file of toWrite) {
    await downloader.fileTo(link.repositoryId, version.id, file, path.join(root, ...file.path.split("/")));
  }
  console.log(
    `Put back ${plural(toWrite.length, "file")} from ${accent(`v${version.sequence}`)}: ` +
      `${version.message.split("\n")[0]}`,
  );
  for (const file of toWrite.slice(0, 20)) console.log(`  ${green("restored")} ${file.path}`);
  if (toWrite.length > 20) console.log(dim(`  …and ${toWrite.length - 20} more`));
  console.log(dim("The folder's link has not moved. cbx submit saves the folder as it is now."));
  return 0;
}
