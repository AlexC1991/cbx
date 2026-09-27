/** Refusals shared by several local-history operations. */

/** Unsaved work stands where an operation would write; nothing was changed. */
export class UnsavedChanges extends Error {
  readonly files: string[];
  constructor(files: string[], action: string, remedy = "Save them first, or add --force to discard them.") {
    super(
      `${action} would overwrite unsaved changes to ${files.length} file${files.length === 1 ? "" : "s"}. ${remedy}`,
    );
    this.files = files;
  }
}

/** A merge save was asked for while conflict markers are still in files. */
export class UnresolvedConflicts extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(
      `${files.length} file${files.length === 1 ? " still has" : "s still have"} conflict markers. ` +
        `Edit ${files.length === 1 ? "it" : "them"}, or take one side with cbx merge --mine or --theirs, then save.`,
    );
    this.files = files;
  }
}
