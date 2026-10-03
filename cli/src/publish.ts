/**
 * Publishing a version — the one description of it.
 *
 * Three things now ask for a version to be made: `cbx submit`, a git push
 * through the remote helper, and the desktop application. They differ in where
 * the files came from and in what they say afterwards, and in nothing else.
 * The part they share is a contract with sharp edges:
 *
 *   - a deleted path belongs in `include` *and* in `deletions`. `include` is
 *     everything this version has something to say about; `deletions` marks
 *     which of those are gone deliberately rather than unreadable. Listing a
 *     removal only in `deletions` leaves it out of the changes entirely, so
 *     the file quietly keeps its old copy and the publish reports success.
 *   - `known` is what the caller believes the project holds. Omit it and a
 *     file present in the version but absent from the caller's tree cannot be
 *     told apart from one the caller deleted.
 *   - `expectedHeadVersionId` is what turns a publish into a compare-and-swap.
 *     Without it a concurrent save is overwritten instead of merged.
 *
 * Each of those was learned twice, once per caller, and the second time as a
 * bug. Written down here so a fourth caller inherits the answers instead of
 * finding them.
 */
import type { UploadRequest } from "../../cbx/src/core/upload.js";

export type VersionInput = {
  /** The folder the files are read from. A checkout, or a scratch tree. */
  localPath: string;
  /** What this machine hashed last time, by path, where it still applies. */
  knownDigests?: Map<string, { size: number; mtimeMs: number; sha256: string }>;
  /** Paths this version adds or changes. */
  changed: string[];
  /*
    Paths deliberately left out, when `changed` is a view rather than the whole
    selection.

    `changedFiles` stops at twenty thousand rows, and `cbx submit` was handing
    exactly those rows over as the list of what to send — so a folder past that
    many files saved the first twenty thousand and silently left the rest out.
    A save that quietly holds less than the folder is the one failure a backup
    tool must not have.

    Present means "everything the rules allow except these". Absent keeps
    `changed` exhaustive, which is what the git remote needs: a pushed commit
    is an explicit list of paths and nothing else.
  */
  excluded?: string[];
  /** Paths this version removes. */
  deleted: string[];
  message: string;
  /** Used only when the project does not exist yet. */
  projectName: string;
  repositoryId: string | null;
  /** The version this publish is based on. Null claims the project is empty. */
  baseVersionId: string | null;
  /** The line it lands on. Omitted means `main`. */
  track?: string;
  /** Path to digest of what the caller believes the project holds. */
  known?: Record<string, string>;
  /*
    Publish files the ignore rules exclude, on purpose. Import and git push
    need it: a repository routinely tracks paths its own `.gitignore` now
    excludes, because the rule came after the file, and dropping them would
    make the publish quietly lossy.
  */
  allowIgnored?: boolean;
  /*
    Publish a credential on purpose.

    Deliberately separate from `allowIgnored`, which git push always sends:
    "this repository tracks a file its rules exclude" and "there is a key in
    here and I mean it" are different statements, and one must never imply
    the other.
  */
  allowSecrets?: boolean;
  acknowledged?: boolean;
  acknowledgedNoLicence?: boolean;
  /** Whether files run, by path, when the caller knows better than the disk. */
  executable?: Map<string, boolean>;
};

/** Turn what a caller has into what the uploader expects. */
export function uploadRequestFor(input: VersionInput): UploadRequest {
  return {
    localPath: input.localPath,
    // Both lists. See the note at the top of this file.
    include: [...input.changed, ...input.deleted],
    ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
    deletions: input.deleted,
    message: input.message,
    projectName: input.projectName,
    repositoryId: input.repositoryId,
    baseVersionId: input.baseVersionId,
    ...(input.track ? { track: input.track } : {}),
    ...(input.allowIgnored ? { allowIgnored: true } : {}),
    ...(input.allowSecrets ? { allowSecrets: true } : {}),
    ...(input.acknowledged ? { acknowledged: true } : {}),
    ...(input.acknowledgedNoLicence ? { acknowledgedNoLicence: true } : {}),
    ...(input.executable ? { executable: input.executable } : {}),
    ...(input.baseVersionId
      ? { expectedHeadVersionId: input.baseVersionId }
      : {}),
    ...(input.known ? { known: input.known } : {}),
    /*
      Digests this machine has taken before, so an unchanged file is not read
      again. The desktop has always passed these; the command line never did.
    */
    ...(input.knownDigests ? { knownDigests: input.knownDigests } : {}),
  };
}

/** Why a publish did not happen, in terms a caller can act on. */
export type PublishFailure =
  /*
    Somebody else saved first and the two overlap. The work is kept and
    complete; it is waiting on a decision. Never report this as saved — what
    other people see has not changed.
  */
  | { kind: "conflict"; message: string }
  /*
    The service found a credential in the files. Not a failure to retry: the
    fix is to take the key out and, if it has ever been published, replace it
    at the service that issued it. A push cannot pass an override because git
    has nowhere to put the question.
  */
  | { kind: "credentials"; message: string }
  /*
    The connection failed part way. This says nothing about whether the work
    was done: the service records the attempt, so running the same command
    again is answered with the version it already made rather than a second
    one. Somebody who is not told this will assume the worst and redo it.
  */
  | { kind: "interrupted"; message: string }
  | null;

export function classifyPublishFailure(error: unknown): PublishFailure {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "merge_required" || code === "track_moved") {
    return { kind: "conflict", message };
  }
  /*
    A credential the service refused. Named separately because the answer is
    not "try again" — it is "take the key out", and for a push there is no
    flag to pass instead, because git has nowhere to ask the question.
  */
  if (code === "version_credentials") {
    return { kind: "credentials", message };
  }
  if (
    !code &&
    /fetch failed|ECONNRESET|socket hang up|network|ETIMEDOUT/i.test(message)
  ) {
    return { kind: "interrupted", message };
  }
  return null;
}
