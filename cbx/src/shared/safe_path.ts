/**
 * Whether a path from a version may be written into somebody's folder.
 *
 * Written after Gitea's CVE-2026-60004, where repository content landed in a
 * hooks directory and git ran it. Nothing here runs git, but the folder a
 * project is fetched into very often is a git checkout — and a version holding
 * `.git/config` would have been written over the real one. A `core.fsmonitor`
 * line in that file runs a command on the next `git status`, with no
 * executable bit needed; a plain file named `.git` replaced the whole
 * directory with a pointer to one the version could also supply.
 *
 * The service refuses these paths when a version is saved. They are refused
 * here as well because this is the side that writes to disk: it must not rest
 * on the server having been right, having been uncompromised, or having held
 * the same rules when an older version was saved.
 *
 * Shared by every writer — fetching, restoring, unbundling — so there is one
 * rule, not one per place that happened to think of it.
 */
import path from "node:path";

/**
 * A name git treats as its own directory.
 *
 * The same comparison git's own `verify_path` makes with its NTFS and HFS
 * protections on: any case, trailing dots and spaces dropped, an alternate
 * data stream dropped, and the 8.3 short name Windows gives `.git`.
 */
export function isGitDirectoryName(part: string): boolean {
  const name = part.split(":")[0]!.replace(/[. ]+$/, "").toLowerCase();
  return name === ".git" || /^git~\d+$/.test(name);
}

/**
 * A name CBX keeps its local history under, compared the way git's is.
 *
 * A version holding `.cbx/lines/main` would otherwise move somebody's line to
 * a save of the version's choosing the moment it was fetched.
 */
export function isCbxDirectoryName(part: string): boolean {
  return part.split(":")[0]!.replace(/[. ]+$/, "").toLowerCase() === ".cbx";
}

/** Why this path must not be written, or null when it may. */
export function whyUnsafe(relative: string): string | null {
  if (!relative) return "it is empty";
  if (relative.includes("\0")) return "it contains a NUL character";
  if (/^[\\/]/.test(relative) || /^[a-zA-Z]:/.test(relative)) {
    return "it is absolute";
  }
  for (const part of relative.split(/[\\/]/)) {
    if (part === "..") return "it climbs out of the folder";
    if (isGitDirectoryName(part)) return "it writes into git's own directory";
    if (isCbxDirectoryName(part)) return "it writes into CBX's own history";
    /* A stream or a drive-relative name on Windows; refused by the service too. */
    if (process.platform === "win32" && part.includes(":")) {
      return "it names a Windows data stream";
    }
  }
  return null;
}

/**
 * The path's parts, or an error naming the path and why.
 *
 * Both separators split it, because on Windows either one is a separator:
 * `a\..\..\x` is three climbs there, whatever a check splitting on `/` saw.
 */
export function safeParts(relative: string): string[] {
  const reason = whyUnsafe(relative);
  if (reason) {
    throw new Error(`That version contains an unsafe path (${reason}): ${relative}`);
  }
  return relative.split(/[\\/]/).filter((part) => part && part !== ".");
}

/**
 * Where a checked path lands under `root`, confirmed to be inside it.
 *
 * The part checks above should make this impossible to fail. It is here so
 * that the next check somebody forgets does not become the next escape.
 */
export function inside(root: string, relative: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, ...safeParts(relative));
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`That version contains a path outside the folder: ${relative}`);
  }
  return full;
}
