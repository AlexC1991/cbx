/**
 * What `cbx help` prints.
 *
 * Generated from the registry rather than written out, so a command that
 * exists is listed and a command that is listed exists. The previous usage
 * text was maintained by hand next to the dispatch table, which is the
 * arrangement where the two drift and nobody finds out until somebody follows
 * the help and it does not work.
 *
 * Two levels, because they answer different questions. The list answers "what
 * can this thing do", and is scanned rather than read — so it is one line per
 * command, aligned, grouped by what somebody is trying to achieve. The detail
 * answers "how exactly do I use this one", and is read properly, so it can
 * afford whole sentences and examples.
 */

import { GROUP_ORDER, LISTING_ORDER, type CommandSpec, type Registry } from "./registry.js";
import { accent, bold, dim } from "./colour.js";

/** The widest the usage column may be; a longer usage needs a `brief`. */
export const USAGE_COLUMN = 30;

/** What the command list shows in the usage column. */
export const listedUsage = (spec: CommandSpec): string => spec.brief ?? spec.usage;

/** Longest visible usage, so the summary column lines up across every group. */
function nameColumn(specs: CommandSpec[]): number {
  return specs.reduce(
    (widest, spec) => Math.max(widest, listedUsage(spec).length),
    0,
  );
}

/** Where a command sits inside its group: by LISTING_ORDER, then as declared. */
function rank(spec: CommandSpec, declared: number): number {
  const at = LISTING_ORDER.indexOf(spec.name);
  return at === -1 ? LISTING_ORDER.length + declared : at;
}

export function renderHelp(registry: Registry, version: string): string {
  const listed = registry.specs.filter((spec) => !spec.deprecatedBy);
  const column = Math.min(nameColumn(listed), USAGE_COLUMN);
  const lines: string[] = [
    `${bold("cbx")} ${dim(version)} — the CBX engine, for CodeRook`,
    "",
  ];

  for (const group of GROUP_ORDER) {
    const inGroup = listed
      .map((spec, declared) => ({ spec, order: rank(spec, declared) }))
      .filter(({ spec }) => spec.group === group)
      .sort((a, b) => a.order - b.order)
      .map(({ spec }) => spec);
    if (!inGroup.length) continue;
    lines.push(bold(group));
    for (const spec of inGroup) {
      lines.push(`  ${listedUsage(spec).padEnd(column)}  ${spec.summary}`);
    }
    lines.push("");
  }

  lines.push(
    dim("cbx help <command>   the full usage, options and examples for one command"),
    dim("CODEROOK_TOKEN       used instead of the stored sign-in, for automated runs"),
    dim("CODEROOK_API_URL     point at another service"),
  );
  return lines.join("\n");
}

export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [
    `${bold("cbx " + spec.name)} — ${spec.summary}`,
    "",
    bold("Usage"),
    `  cbx ${spec.usage}`,
  ];

  if (spec.aliases?.length) {
    lines.push("", bold("Also"), `  ${spec.aliases.map((alias) => `cbx ${alias}`).join("  ")}`);
  }

  if (spec.detail) {
    lines.push("", spec.detail.trim());
  }

  if (spec.options?.length) {
    const width = spec.options.reduce(
      (widest, option) => Math.max(widest, option.flags.length),
      0,
    );
    lines.push("", bold("Options"));
    for (const option of spec.options) {
      lines.push(`  ${option.flags.padEnd(width)}  ${option.description}`);
    }
  }

  if (spec.examples?.length) {
    lines.push("", bold("Examples"));
    for (const example of spec.examples) lines.push(`  ${accent(example)}`);
  }

  return lines.join("\n");
}

/**
 * What to print when somebody asks for help on something that is not a command.
 *
 * Suggests a near match where there is one, and otherwise points at the list —
 * a confident wrong suggestion sends somebody off to read the wrong page.
 */
export function renderUnknown(typed: string, suggestion: string | null): string {
  const lines = [`Unknown command: ${typed}`];
  if (suggestion) lines.push(`Did you mean ${accent("cbx " + suggestion)}?`);
  lines.push(dim("Run cbx help to see everything."));
  return lines.join("\n");
}
