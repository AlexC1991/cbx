/**
 * How `cbx status` lists what changed, on its own so the quickest path
 * (bin.ts, answered by the engine) prints exactly what the full status does.
 */
import type { Changes } from "../../cbx/src/local/history.js";
import { accent, dim, green, red } from "./paint.js";

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

export function printChanges(changes: Changes, limit = 50): void {
  const rows: Array<[string, string]> = [
    ...changes.added.map((file): [string, string] => [green("added   "), file]),
    ...changes.modified.map((file): [string, string] => [accent("changed "), file]),
    ...changes.deleted.map((file): [string, string] => [red("deleted "), file]),
  ].sort((left, right) => (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  for (const [mark, file] of rows.slice(0, limit)) console.log(`  ${mark}${file}`);
  if (rows.length > limit) console.log(dim(`  … and ${rows.length - limit} more`));
}

/** Everything after the first line when something changed. */
export function printChangedSummary(changes: Changes): void {
  const count = changes.added.length + changes.modified.length + changes.deleted.length;
  console.log(`${plural(count, "file")} changed since the last save:`);
  printChanges(changes);
  console.log(dim(`cbx diff shows the lines; cbx save -m "…" records them.`));
}
