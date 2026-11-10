/**
 * What `cbx status` prints in a folder with a local history, kept apart from
 * the rest of the local commands so it can run without loading them.
 *
 * Status is the command people run most, and in a local history it needs only
 * the history itself: no sign-in, no network, none of the upload or project
 * code. bin.ts answers it from here directly; the full command table uses the
 * same function, so the two can never print differently.
 */
import path from "node:path";

import { changeCount, status } from "../../cbx/src/local/history.js";
import type { Repository } from "../../cbx/src/local/repository.js";

import { accent, bold, dim, green, red, short } from "./paint.js";
import { plural, printChangedSummary, printChanges } from "./status_lines.js";

export { accent, bold, dim, green, plural, printChanges, red, short };
/** The status of a local history, printed. */
export async function printLocalStatus(repository: Repository): Promise<number> {
  const now = await status(repository);
  console.log(
    `${bold(path.basename(repository.root))} on ${accent(now.line)}` +
      (now.head ? dim(`  last saved ${short(now.head.id)}: ${now.head.message.split("\n")[0]}`) : dim("  nothing saved yet")),
  );
  if (now.merging) {
    const left = now.merging.unresolved.length;
    console.log(
      `Merging ${accent(short(now.merging.theirs))}: ` +
        (left ? red(`${plural(left, "file")} still ${left === 1 ? "has" : "have"} conflict markers`) : green("no conflict markers left")),
    );
    for (const conflict of now.merging.conflicts) {
      const how =
        conflict.kind === "text"
          ? now.merging.unresolved.includes(conflict.path) ? "markers in it" : "edited"
          : conflict.kind === "binary"
            ? "both changed; this line's copy is in the folder"
            : conflict.kind === "deleted-here"
              ? "deleted here, changed there; their copy is in the folder"
              : "changed here, deleted there; this copy is in the folder";
      console.log(`  ${red("conflict")} ${conflict.path}  ${dim(how)}`);
    }
    console.log(dim(`Finish with cbx save, take a side with cbx merge --mine or --theirs, or cbx merge --cancel.`));
  }
  const count = changeCount(now.changes);
  if (!count) {
    console.log("Nothing has changed since the last save.");
    return 0;
  }
  printChangedSummary(now.changes);
  return 0;
}
