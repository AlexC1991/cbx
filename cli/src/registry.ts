/**
 * One table that both runs the commands and describes them.
 *
 * The usage text used to be a hand-written string beside a separate dispatch
 * table, which is the arrangement where help slowly stops being true: a
 * command gets added and the text does not mention it, or an option is renamed
 * and the text still lists the old one. Nobody notices, because nothing checks.
 *
 * Here the description is part of the command. `cbx help` is generated
 * from the same rows that decide what runs, so the two cannot disagree — and a
 * command added without a summary is a type error rather than an omission.
 */

export type CommandGroup =
  | "Getting started"
  | "Working with a folder"
  | "History on this machine"
  | "Your projects"
  | "People"
  | "When somebody saved first"
  | "Bundles"
  | "Actions"
  | "Other";

/** The order groups appear in help, which is the order somebody meets them. */
export const GROUP_ORDER: CommandGroup[] = [
  "Getting started",
  "Working with a folder",
  "History on this machine",
  "Your projects",
  "People",
  "When somebody saved first",
  "Bundles",
  "Actions",
  "Other",
];

export type CommandOption = {
  /** As typed, including the short form: "-m, --message <text>". */
  flags: string;
  description: string;
};

export type CommandSpec = {
  name: string;
  /** Other names that reach the same command. */
  aliases?: string[];
  group: CommandGroup;
  /** One line, lower case, no full stop — it sits in a column. */
  summary: string;
  /** How it is typed, without the leading "coderook". */
  usage: string;
  /** The longer explanation, shown by `cbx help <command>`. */
  detail?: string;
  options?: CommandOption[];
  examples?: string[];
  /**
   * Set when a name is kept only so existing scripts keep working. Hidden
   * from the command list and announced when used, so it can eventually go.
   */
  deprecatedBy?: string;
  run: (parsed: Parsed) => Promise<number>;
};

/** The shape the argument parser produces, mirrored here to avoid a cycle. */
export type Parsed = {
  positional: string[];
  flags: Map<string, string | true>;
};

export type Registry = {
  /** In declaration order, which is the order help lists them. */
  specs: CommandSpec[];
  /** Every name and alias, pointing at its spec. */
  lookup: Map<string, CommandSpec>;
};

export function buildRegistry(specs: CommandSpec[]): Registry {
  const lookup = new Map<string, CommandSpec>();
  for (const spec of specs) {
    lookup.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) lookup.set(alias, spec);
  }
  return { specs, lookup };
}

/**
 * The nearest command to something mistyped.
 *
 * Levenshtein distance, capped so that a genuinely unrelated word gets no
 * suggestion at all — "did you mean bundle?" in answer to "deploy" is worse
 * than saying nothing, because it sends somebody to read the wrong help.
 */
export function nearestCommand(
  registry: Registry,
  typed: string,
): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const name of registry.lookup.keys()) {
    const distance = editDistance(typed, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (!best) return null;
  const tolerance = typed.length <= 4 ? 1 : 3;
  return best.distance <= tolerance ? best.name : null;
}

function editDistance(a: string, b: string): number {
  /*
    One row at a time rather than a full matrix. Both are short, so this is
    not about speed — a flat array of numbers is simply easier to convince a
    type checker about than a grid of possibly-absent rows.
  */
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
