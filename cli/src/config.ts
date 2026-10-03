/**
 * Where the command-line tool keeps its credential and its project links.
 *
 * The desktop uses the operating-system vault; a terminal has no such thing
 * everywhere, so the token lives in a file that only its owner can read. The
 * location follows each platform's convention rather than scattering dot
 * directories about.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  access,
  chmod,
  link as hardLink,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Credentials } from "../../cbx/src/core/credentials.js";

export const DEFAULT_API = "https://api.coderook.com";

export function apiOrigin(): string {
  return (process.env.CODEROOK_API_URL || DEFAULT_API).replace(/\/+$/, "");
}

/**
 * The website that goes with the service, for a link somebody can open.
 *
 * Derived rather than configured: the service answers on `api.` in front of
 * the site's own host, so taking that off gives the address people use. A
 * service anywhere else — a local one on a port — has no site this can name,
 * and null says so rather than printing a link that goes nowhere.
 */
export function siteOrigin(api = apiOrigin()): string | null {
  try {
    const url = new URL(api);
    if (!url.hostname.startsWith("api.")) return null;
    url.hostname = url.hostname.slice("api.".length);
    return url.origin;
  } catch {
    return null;
  }
}

/** The per-user configuration directory, per platform convention. */
export function configDirectory(): string {
  if (process.env.CODEROOK_CONFIG_DIR) return process.env.CODEROOK_CONFIG_DIR;
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
      "CodeRook",
    );
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "CodeRook");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
    "coderook",
  );
}

const tokenFile = () => path.join(configDirectory(), "token");
/*
  One small file per folder, under `links/`.

  It was one file for every folder this machine had ever linked, read whole and
  rewritten whole — pretty-printed — by every command. On a real machine that
  file reached 419 MB across 549 folders, 536 of which no longer existed, and
  every `cbx` paid about three seconds to read it before doing anything and
  another two and a half to write it back after a save. It also lost updates:
  two commands in two folders each rewrote the lot, and the later one erased
  the earlier one's change.

  The old file is read once, split into these, and renamed out of the way.
*/
const linksDirectory = () => path.join(configDirectory(), "links");
const legacyLinksFile = () => path.join(configDirectory(), "links.json");

/**
 * Write a file only its owner can read, and atomically.
 *
 * The temporary name carries this process's own identity. Sharing one — as
 * `${target}.tmp` did — means two runs at once write the same scratch file
 * and then race to move it, which on Windows fails outright and elsewhere
 * quietly hands one run the other's bytes.
 *
 * The move is retried briefly because Windows refuses a rename while another
 * process still has the destination open, which during a race is ordinary
 * rather than exceptional.
 */
async function writePrivate(target: string, body: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temporary, body, "utf8");
  // Windows ignores the mode; on everything else this is what keeps the
  // token out of other accounts' reach.
  await chmod(temporary, 0o600).catch(() => undefined);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) {
          throw error;
        }
        await new Promise((wake) => setTimeout(wake, 10 + attempt * 5));
      }
    }
  } finally {
    // A failed move must not leave scratch files accumulating beside it.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function storeToken(token: string): Promise<void> {
  await writePrivate(tokenFile(), `${token.trim()}\n`);
}

/**
 * The token, from the environment first so continuous integration can supply
 * one without writing anything to disk.
 */
export async function loadToken(): Promise<string> {
  const fromEnvironment = process.env.CODEROOK_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return (await readFile(tokenFile(), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function clearToken(): Promise<void> {
  await rm(tokenFile(), { force: true });
}

export const credentials: Credentials = {
  origin: apiOrigin,
  token: loadToken,
};

/** Which repository a folder saves into, and the version it last saw. */
export type Link = {
  repositoryId: string;
  slug: string;
  sequence: number;
  /*
    The line this folder saves onto. Absent means `main`, which is what every
    folder meant before a project could have more than one — so a link written
    by an older build needs no migration to keep behaving as it did.

    A fact about this copy rather than about the account: two checkouts of one
    project can sit on different lines, which is most of the point of them.
  */
  track?: string;
  /*
    The identifier of the version this folder was last reconciled with, not
    merely its number. Publishing sends it so the service can tell whether
    anyone else has saved since — a sequence number cannot do that, because
    it says where the folder is, not what it was looking at.

    Optional so that folders linked before this existed keep working; they
    simply publish without the check until their next reconcile.
  */
  versionId?: string;
  /**
   * Canonical name for the Version actually materialised in this folder.
   * `versionId` remains as an on-disk compatibility mirror for older CLIs.
   */
  baseVersionId?: string;
  /** Newest remote Track head observed; never used as the publish base. */
  observedHeadVersionId?: string;
  /*
    What CodeRook last put on this machine: path to the digest of the copy
    actually placed here. Not the same as the version — a merge can change a
    file, or add somebody else's, without those bytes ever arriving in this
    folder.

    Keeping the two apart is what lets a scan tell the three cases apart:
    disk matches this but differs from the version (a remote change not yet
    fetched — leave it alone), disk differs from this (a real local edit —
    send it), and present here but absent from disk (a real deletion). A set
    of path names cannot distinguish those; digests can.
  */
  local?: Record<string, string>;
  /*
    A fetch that began but was never recorded as finished.

    Applying a version touches the folder file by file, so an interruption
    leaves some of it moved on and the materialisation record still describing
    what was there before. Without knowing a fetch was in flight, the next one
    reads its own half-finished work as somebody's unsaved edits and refuses
    to continue — leaving the folder stuck in the one state it should be
    easiest to get out of.

    Written before anything is touched and cleared once the record is
    written, so its presence means exactly "a fetch to this version did not
    finish".
  */
  fetching?: { versionId: string; sequence: number };
  /** Path to content digest for that version. */
  manifest: Record<string, string>;
};

/**
 * One name for one folder, whatever route was taken to reach it.
 *
 * A folder can be addressed as `C:\project`, through a junction, through a
 * symlink, or through a mapped drive, and every one of those is a different
 * string. Keying on the string gives the same folder four independent
 * connections, four independent records of what it holds, and four chances
 * for one to overwrite another's work. Resolving to the real path first is
 * what makes them one workspace.
 *
 * A path that does not exist yet — a clone destination — cannot be resolved,
 * so it falls back to the plain form. It becomes resolvable the moment the
 * folder is created, which is before anything is ever recorded against it.
 */
export function keyFor(localPath: string): string {
  const absolute = path.resolve(localPath);
  try {
    // Windows returns an extended-length path here; the prefix is an
    // addressing detail, not part of the identity, so it comes back off.
    return realpathSync.native(absolute).replace(/^\\\\\?\\/, "").toLowerCase();
  } catch {
    return absolute.toLowerCase();
  }
}

/** How the key used to be worked out, so existing links keep working. */
const legacyKeyFor = (localPath: string) => path.resolve(localPath).toLowerCase();

/**
 * A link record that exists and cannot be read.
 *
 * Deliberately not the same as "no link". Reading a damaged record as absent
 * makes a linked folder look new, and the next save creates a second project
 * beside the real one — so this stops and names the file instead.
 */
export class DamagedLinkError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(
      `CodeRook's record of which project a folder belongs to is damaged: ${file}\n` +
        "Nothing was changed. Restore that file from a backup, or move it aside " +
        "to treat the folder as not yet linked.",
    );
    this.name = "DamagedLinkError";
    this.cause = cause;
  }
}

/** The file one folder's link lives in. Hashed, because a key is a path. */
export function linkFileFor(localPath: string): string {
  return storedFileFor(keyFor(localPath));
}

const storedFileFor = (key: string) =>
  path.join(
    linksDirectory(),
    `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`,
  );

/**
 * What goes on disk. `local` is dropped when it is the manifest again — which
 * it was for 467 of 549 real links, each one a full file list written twice.
 * A forgotten folder leaves a marker rather than nothing, so that a migration
 * still in progress cannot write the old link back over the forgetting.
 */
type StoredLink =
  | { key: string; forgotten: true }
  | {
      key: string;
      link: Omit<Link, "local"> & {
        local?: Record<string, string>;
        localIsManifest?: true;
      };
    };

function sameMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

function pack(key: string, link: Link): StoredLink {
  const { local, ...rest } = link;
  if (local && sameMap(local, link.manifest)) {
    return { key, link: { ...rest, localIsManifest: true } };
  }
  return { key, link: local ? { ...rest, local } : rest };
}

function unpack(stored: Extract<StoredLink, { link: unknown }>): Link {
  const { localIsManifest, ...link } = stored.link;
  /* A copy, so a caller changing one cannot quietly change the other. */
  return localIsManifest ? { ...link, local: { ...link.manifest } } : link;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** One folder's record: undefined when there is none, and loud when damaged. */
async function readStored(key: string): Promise<StoredLink | undefined> {
  const file = storedFileFor(key);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stored = JSON.parse(text) as StoredLink;
    if (stored?.key !== key) throw new Error("the record is for another folder");
    return stored;
  } catch (error) {
    throw new DamagedLinkError(file, error);
  }
}

/**
 * Write a record only if there is not one already.
 *
 * The migration's writer. A link written by a command running at the same
 * moment is newer than anything in the old file, and must win. A hard link
 * makes "create only if absent" one atomic step, and a reader never sees a
 * half-written file; where the disk cannot do hard links the check and the
 * move are two steps, which is only a race against a command in that same
 * folder in the same instant.
 */
async function writeStoredIfAbsent(stored: StoredLink): Promise<void> {
  const target = storedFileFor(stored.key);
  if (await exists(target)) return;
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(stored), "utf8");
  await chmod(temporary, 0o600).catch(() => undefined);
  try {
    await hardLink(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && !(await exists(target))) {
      await rename(temporary, target);
      return;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Split the old single file into one per folder, once.
 *
 * Whoever renames it to `.migrating` first does the work, and anyone arriving
 * while that is going on — or after a run that was interrupted — works from
 * the `.migrating` copy too. Every write here is "only if absent", so running
 * it twice is harmless and a newer link written meanwhile is never overwritten.
 *
 * A damaged old file is put back and reported rather than migrated as empty:
 * that would silently unlink every folder on the machine.
 */
async function migrateLegacyLinks(): Promise<void> {
  const legacy = legacyLinksFile();
  const claimed = `${legacy}.migrating`;
  await rename(legacy, claimed).catch(() => undefined);
  let text: string;
  try {
    text = await readFile(claimed, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let links: Record<string, Link>;
  try {
    links = JSON.parse(text) as Record<string, Link>;
  } catch (error) {
    await rename(claimed, legacy).catch(() => undefined);
    throw new DamagedLinkError(legacy, error);
  }
  for (const [key, link] of Object.entries(links)) {
    await writeStoredIfAbsent(pack(key, link));
  }
  /* Kept rather than deleted: it is somebody's data, and moving it is enough. */
  await rename(claimed, `${legacy}.migrated`).catch(() => undefined);
}

async function lookUp(localPath: string): Promise<Link | null | "forgotten"> {
  for (const key of new Set([keyFor(localPath), legacyKeyFor(localPath)])) {
    const stored = await readStored(key);
    if (!stored) continue;
    if ("forgotten" in stored) return "forgotten";
    return unpack(stored);
  }
  return null;
}

/*
  A copy of the link kept in the folder itself, beside the offline outbox.

  The machine's own record is keyed by the folder's path, so the same folder
  seen from another operating system (a drive letter from Windows, a mount
  point from Linux, on the same disk) or from another machine was a stranger,
  and every project had to be cloned again into a new folder. `.coderook` is
  never scanned or uploaded, and the copy holds no token: only which project
  and version the folder stands on, as `.git` records its remote.
*/
const folderLinkFile = (localPath: string) =>
  path.join(path.resolve(localPath), ".coderook", "link.json");

async function readFolderLink(localPath: string): Promise<Link | null> {
  try {
    const raw = JSON.parse(await readFile(folderLinkFile(localPath), "utf8")) as Partial<Link>;
    if (typeof raw.repositoryId !== "string" || typeof raw.slug !== "string") return null;
    return {
      ...raw,
      manifest: raw.manifest ?? {},
      sequence: Number(raw.sequence ?? 0),
    } as Link;
  } catch {
    return null;
  }
}

async function writeFolderLink(localPath: string, link: Link): Promise<void> {
  try {
    const directory = path.dirname(folderLinkFile(localPath));
    await mkdir(directory, { recursive: true });
    /* Git leaves it alone too, without anybody editing their .gitignore. */
    await writeFile(path.join(directory, ".gitignore"), "*\n").catch(() => undefined);
    await writeFile(folderLinkFile(localPath), JSON.stringify(link));
  } catch {
    /* A folder that cannot hold the copy still has the machine's record. */
  }
}

export async function readLink(localPath: string): Promise<Link | null> {
  let found = await lookUp(localPath);
  if (
    !found &&
    ((await exists(legacyLinksFile())) ||
      (await exists(`${legacyLinksFile()}.migrating`)))
  ) {
    await migrateLegacyLinks();
    found = await lookUp(localPath);
  }
  /* Unlinked on this machine on purpose: the folder's copy does not overrule that. */
  if (found === "forgotten") return null;
  let link = found;
  if (!link) {
    link = await readFolderLink(localPath);
    /* Adopted, so this machine knows the folder from now on. */
    if (link) await writeLink(localPath, link);
  }
  if (!link) return null;
  return {
    ...link,
    baseVersionId: link.baseVersionId ?? link.versionId,
  };
}

/**
 * Forget which project a folder belongs to.
 *
 * Both keys, because a folder linked by an older build is recorded under the
 * old one and leaving that behind would mean the folder was still linked
 * afterwards — which is the one thing this is for.
 */
export async function forgetLink(localPath: string): Promise<boolean> {
  if (!(await readLink(localPath))) return false;
  for (const key of new Set([keyFor(localPath), legacyKeyFor(localPath)])) {
    const forgotten: StoredLink = { key, forgotten: true };
    await writePrivate(storedFileFor(key), JSON.stringify(forgotten));
  }
  await rm(folderLinkFile(localPath), { force: true });
  return true;
}

export async function writeLink(localPath: string, link: Link): Promise<void> {
  const key = keyFor(localPath);
  const baseVersionId = link.baseVersionId ?? link.versionId;
  const stored = pack(key, {
    ...link,
    ...(baseVersionId ? { baseVersionId, versionId: baseVersionId } : {}),
  });
  await writePrivate(storedFileFor(key), JSON.stringify(stored));
  await writeFolderLink(localPath, {
    ...link,
    ...(baseVersionId ? { baseVersionId, versionId: baseVersionId } : {}),
  });
  // A folder recorded under the old key moves to the new one rather than
  // being left behind as a second connection to the same place.
  const legacy = legacyKeyFor(localPath);
  if (legacy !== key) await rm(storedFileFor(legacy), { force: true });
}

/**
 * Digests this machine has already taken, by path.
 *
 * Reading a file to hash it is the expensive part of a save, and for a file
 * whose size and modification time are unchanged the hash already taken still
 * describes the bytes. The desktop has kept this record since it was written;
 * the command line never did, so every `cbx submit` read and hashed the whole
 * project again — on a real Unity folder, forty-seven thousand files, to
 * discover that none of them had changed.
 *
 * Kept per project rather than per folder so that a folder moved or cloned
 * twice does not inherit a stranger's record. A miss is free: an entry that
 * does not match is simply ignored and the file is read, which is what used
 * to happen to every file every time.
 */
export type KnownDigest = { size: number; mtimeMs: number; sha256: string };

const digestsFile = (projectId: string) =>
  path.join(configDirectory(), "digests", `${projectId}.json`);

export async function readDigests(
  projectId: string,
): Promise<Map<string, KnownDigest>> {
  try {
    const raw = await readFile(digestsFile(projectId), "utf8");
    return new Map(Object.entries(JSON.parse(raw) as Record<string, KnownDigest>));
  } catch {
    /* No record yet, or one this build cannot read: hash everything. */
    return new Map();
  }
}

export async function writeDigests(
  projectId: string,
  digests: Map<string, KnownDigest>,
): Promise<void> {
  if (!digests.size) return;
  try {
    await writePrivate(
      digestsFile(projectId),
      JSON.stringify(Object.fromEntries(digests)),
    );
  } catch {
    /* The next save hashes again, which is where this started. */
  }
}
