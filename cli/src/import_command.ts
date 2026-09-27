import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Bringing an existing repository in from somewhere else.
 *
 * This imports the *current state* of a repository, not its history. That is
 * a deliberate limit rather than a first draft: replaying history through the
 * public version API costs about a minute per Version on a large project, so
 * a mature repository would take days, and a half-finished import is worse
 * than an honest snapshot. History import waits for a graph-import path.
 *
 * What this does give somebody is the thing that actually blocks them today:
 * a way in that does not involve copying files by hand and losing the
 * `.gitignore` rules along the way.
 *
 * Three details matter and each is handled below rather than left to
 * surprise somebody:
 *
 *  - **The clone is shallow and then discarded.** `--depth 1` fetches one
 *    commit's worth of content instead of the whole history, which is the
 *    difference between a minute and an hour on a large repository. The
 *    `.git` directory is removed before publishing, because sending it would
 *    upload the very history the shallow clone declined to fetch.
 *
 *  - **Ignored files are published on purpose.** Git keeps tracking a file
 *    committed before the rule that excludes it, so real repositories
 *    routinely carry paths their own `.gitignore` now refuses. Dropping them
 *    would make the import quietly lossy, so the import states the override
 *    instead — and says so, rather than doing it silently.
 *
 *  - **Credentials are the machine's, never this tool's.** A public
 *    repository needs none; a private one uses whatever `git` is already
 *    configured with. Nothing here asks for, stores, or forwards a token.
 */

export type ImportPlan = {
  /** Where the working copy was placed. */
  folder: string;
  /** The project name derived for it. */
  name: string;
  /** True when the folder was created by this import and may be removed. */
  temporary: boolean;
};

/**
 * The repository's own name, from the last path segment.
 *
 * Deliberately not the host: an address with no path at all is not a
 * repository, and naming somebody's project `github.com` because the URL was
 * incomplete is the sort of thing they would only notice later.
 */
export function projectNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  /* Drop the scheme and authority so only path segments remain. */
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const afterHost = /^[^/]*:/.test(withoutScheme)
    ? /* scp-style git@host:owner/name */
      withoutScheme.slice(withoutScheme.indexOf(":") + 1)
    : withoutScheme.slice(withoutScheme.indexOf("/") + 1);
  const hasPath =
    withoutScheme.includes("/") || /^[^/]*:/.test(withoutScheme);
  if (!hasPath) return "imported-project";
  const tail = afterHost.split("/").filter(Boolean).pop() ?? "";
  const name = tail.replace(/\.git$/i, "").trim();
  return name || "imported-project";
}

/**
 * Refuse anything that is not a repository location.
 *
 * `git clone` will happily treat a local path as a source, and a URL typed
 * with a scheme this does not expect is more likely a mistake than an
 * intention. Being narrow here keeps the command from doing something
 * surprising with an argument that was meant for something else.
 */
export function looksLikeRepositoryUrl(url: string): boolean {
  const value = url.trim();
  if (/^(https?|git|ssh):\/\//i.test(value)) return true;
  /* scp-style: git@host:owner/name.git */
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return true;
  return false;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDirectory(target: string): Promise<boolean> {
  try {
    const entries = await readdir(target);
    return entries.length === 0;
  } catch {
    return true;
  }
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await run("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shallow-clone into a working folder and strip the Git metadata.
 *
 * Returns where the files landed. The caller publishes from there with the
 * ordinary save path, so an import produces exactly the Version an ordinary
 * save of the same files would.
 */
export async function fetchSnapshot(
  url: string,
  into: string | null,
  log: (line: string) => void = () => {},
): Promise<ImportPlan> {
  const name = projectNameFromUrl(url);
  let folder: string;
  let temporary = false;

  if (into) {
    folder = path.resolve(into);
    if ((await exists(folder)) && !(await isEmptyDirectory(folder))) {
      throw new Error(
        `${folder} already has files in it. Import needs an empty folder, ` +
          `so that nothing here is overwritten by what arrives.`,
      );
    }
  } else {
    const base = await mkdtemp(path.join(tmpdir(), "coderook-import-"));
    folder = path.join(base, name);
    temporary = true;
  }

  log(`Fetching ${url}`);
  /*
    --depth 1 for the reason in the header. --single-branch keeps it to the
    default branch: an import takes a snapshot of one line of work, and
    fetching every branch's tip would cost time to produce content this
    command then discards.
  */
  await run(
    "git",
    ["clone", "--depth", "1", "--single-branch", url, folder],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );

  const gitDirectory = path.join(folder, ".git");
  if (await exists(gitDirectory)) {
    await rm(gitDirectory, { recursive: true, force: true });
  }

  return { folder, name, temporary };
}

/** Total bytes and file count of the fetched tree, for the summary line. */
export async function measure(
  folder: string,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      bytes += (await stat(full)).size;
    }
  };
  await walk(folder);
  return { files, bytes };
}

export function humanBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(size < 10 ? 2 : 1)} ${units[unit]}`;
}
