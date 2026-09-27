/**
 * Deliberate failure points, for proving that interruption recovers.
 *
 * Every operation that touches a folder is a sequence of individually correct
 * steps, and the dangerous state is between two of them: half the files
 * replaced, a deletion applied but the record not yet written, a version
 * committed but never learned about. Those states cannot be reached by
 * ordinary testing, because ordinary testing runs the sequence to the end.
 *
 * So the sequence can be cut, at named points, by setting an environment
 * variable. Nothing here does anything at all unless that variable names a
 * point — there is no configuration, no flag and no code path that reaches it
 * otherwise, which is what makes it safe to leave in the shipped build rather
 * than maintaining a separate instrumented one that nobody ever runs.
 */

/** The points an operation can be cut at, and roughly where each one is. */
export type FaultPoint =
  /** Everything downloaded and verified; the folder is still untouched. */
  | "get:after-staging"
  /** One file has been put in place; the rest have not. */
  | "get:after-first-file"
  /** A file the version dropped has been removed; the rest is unfinished. */
  | "get:after-delete"
  /** The folder is fully updated; nothing has recorded that yet. */
  | "get:before-record"
  /** The record is written; temporary files have not been cleared. */
  | "get:after-record"
  /** Objects uploaded and verified; no version row exists yet. */
  | "submit:after-objects"
  /** The version exists on the account; this machine has not recorded it. */
  | "submit:after-commit";

export class InjectedFault extends Error {
  constructor(readonly point: FaultPoint) {
    super(`Interrupted deliberately at ${point}`);
    this.name = "InjectedFault";
  }
}

/**
 * Stop here, if this is the point somebody asked to be interrupted at.
 *
 * Reads the environment on every call rather than caching it, so a test can
 * drive several runs in one process without the first one deciding for all
 * the others.
 */
export function maybeFail(point: FaultPoint): void {
  if (process.env.CODEROOK_FAULT === point) throw new InjectedFault(point);
}
