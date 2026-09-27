/**
 * What changed, from the terminal.
 *
 * This was the one central thing the command line could not do. The service
 * has been able to compare two versions since the beginning — GET /compare
 * answers it from the stored trees — and nothing called the route. Meanwhile
 * the desktop application's diff shells out to `git diff`, so on a project
 * that is not a git repository the feature is silently absent, which is an odd
 * thing for a version host to depend on.
 *
 * So this reads the service's own answer and renders it. Two questions, which
 * people mean at different times:
 *
 *   cbx diff            what have I changed since the version I am on
 *   cbx diff 12         the same, against version 12
 *   cbx diff 11 12      what changed between two saved versions
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  compareVersions,
  fileTextAt,
  versions,
  type TreeChange,
} from "./api.js";
import { readLink } from "./config.js";
import { resolveProject } from "./project_commands.js";
import {
  diffLines,
  foldUnchanged,
  linesOf,
} from "../../cbx/src/shared/merge_diff.js";
import {
  changedFiles,
  readRules,
} from "../../cbx/src/core/worktree.js";

import type { Parsed } from "./registry.js";

/*
  Built rather than typed, so the escape character never sits literally in the
  source. The other command files spell theirs out; this reads the same on a
  terminal and survives being copied through a tool that eats control bytes.
*/
const ESC = String.fromCharCode(27);
const paint = (code: string) => (value: string) =>
  `${ESC}[${code}m${value}${ESC}[0m`;
const dim = paint("2");
const bold = paint("1");
const red = paint("31");
const green = paint("32");
const accent = paint("33");

/*
  The line comparison builds a table of one side's lines against the other's,
  which is exact and quadratic. On a conflicted file — what it was written for
  — that is a few hundred kilobytes. On this repository's own eighteen-thousand
  line runtime it would be gigabytes, so past this a file is reported as
  changed without its lines. Saying so beats both wedging the terminal and
  printing a heuristic diff that quietly invents a change.
*/
const MOST_LINES_COMPARED = 4_000;

/** How a change reads at a glance. */
const MARK: Record<TreeChange["kind"], string> = {
  added: green("+"),
  removed: red("-"),
  changed: accent("~"),
};

/** Print one file's lines, folded to the interesting parts. */
function printHunks(before: string, after: string, context: number): void {
  const left = linesOf(before);
  const right = linesOf(after);
  if (left.length > MOST_LINES_COMPARED || right.length > MOST_LINES_COMPARED) {
    console.log(
      dim(
        `    ${Math.max(left.length, right.length).toLocaleString()} lines — ` +
          `too large to compare line by line`,
      ),
    );
    return;
  }
  for (const chunk of foldUnchanged(diffLines(before, after), context)) {
    if (chunk.kind === "gap") {
      console.log(dim(`    ... ${chunk.skipped} unchanged`));
      continue;
    }
    for (const line of chunk.lines) {
      const at = String(line.candidateLine ?? line.targetLine ?? "").padStart(5);
      if (line.side === "same") console.log(dim(`${at}   ${line.text}`));
      else if (line.side === "candidate")
        console.log(`${dim(at)} ${green("+")} ${green(line.text)}`);
      else console.log(`${dim(at)} ${red("-")} ${red(line.text)}`);
    }
  }
}

/** Resolve `12`, `v12` or a version's name against the newest-first list. */
function versionBy(
  list: Array<{ id: string; sequence: number; name: string | null }>,
  reference: string,
): { id: string; sequence: number } | null {
  const bare = reference.replace(/^v/i, "");
  if (/^[0-9]+$/.test(bare)) {
    const found = list.find((one) => one.sequence === Number(bare));
    return found ? { id: found.id, sequence: found.sequence } : null;
  }
  const named = list.find(
    (one) => (one.name ?? "").toLowerCase() === reference.toLowerCase(),
  );
  return named ? { id: named.id, sequence: named.sequence } : null;
}

/** Whether these bytes are something a line comparison can speak about. */
function isText(value: string): boolean {
  return !value.includes(String.fromCharCode(0));
}

export async function commandDiff(parsed: Parsed): Promise<number> {
  const nameOnly = parsed.flags.has("name-only");
  const context = Number(parsed.flags.get("context") ?? 3) || 3;
  const only = parsed.flags.get("path");
  const named = parsed.flags.get("project");
  const project = await resolveProject(
    typeof named === "string" ? named : undefined,
  );
  if (!project) return 1;

  const list = await versions(project.id);
  if (!list.length) {
    console.log("Nothing saved yet, so there is nothing to compare.");
    return 0;
  }

  const [first, second] = parsed.positional;

  /*
    Two saved versions, compared by the service. That is the whole point of
    asking it rather than fetching both file lists: it walks the stored trees
    and skips any subtree whose id has not moved, so an untouched corner of a
    twenty-thousand-file project costs nothing.
  */
  if (first && second) {
    const from = versionBy(list, first);
    const to = versionBy(list, second);
    if (!from || !to) {
      console.error(red(`No such version: ${from ? second : first}`));
      return 1;
    }
    const changes = (await compareVersions(project.id, from.id, to.id))
      .filter((change) => !only || change.path.includes(String(only)))
      .sort((left, right) => left.path.localeCompare(right.path));
    console.log(
      `${bold(project.slug)} ${dim(`v${from.sequence} -> v${to.sequence}`)}`,
    );
    if (!changes.length) {
      console.log("Nothing differs between them.");
      return 0;
    }
    for (const change of changes) {
      console.log(`${MARK[change.kind]} ${change.path}`);
      if (nameOnly || change.kind !== "changed") continue;
      const [before, after] = await Promise.all([
        fileTextAt(project.id, from.id, change.path),
        fileTextAt(project.id, to.id, change.path),
      ]);
      if (before === null || after === null) {
        console.log(dim("    not text"));
        continue;
      }
      printHunks(before, after, context);
    }
    const many = changes.length === 1 ? "" : "s";
    console.log(dim(`\n${changes.length} file${many} differ${many ? "" : "s"}`));
    return 0;
  }

  /*
    This folder against a saved version — the question somebody has open in
    front of them, and the reason `cbx status` was never enough on its own: it
    says which files changed and never what changed inside them.
  */
  const link = await readLink(process.cwd());
  if (!link) {
    console.error(
      red("This folder is not linked to a project, so there is no local side."),
    );
    return 1;
  }
  const against = first
    ? versionBy(list, first)
    : { id: link.baseVersionId ?? list[0]!.id, sequence: link.sequence };
  if (!against) {
    console.error(red(`No such version: ${first}`));
    return 1;
  }

  const folder = process.cwd();
  const rules = await readRules(folder);
  /*
    Which files differ is decided here, from digests, before anything is
    fetched.

    The first version of this compared contents, which meant downloading every
    file in the project to find out which ones had moved — on this repository
    that is eleven hundred requests to report a handful of edits. `changedFiles`
    already answers the question locally and keeps a digest cache while it does
    it, so the service is asked only for the files that actually differ.
  */
  const saved = link.manifest ?? {};
  const changed = (
    await changedFiles(folder, rules, new Map(Object.entries(saved)), "synchronize")
  )
    .filter((one) => !only || one.path.includes(String(only)))
    .sort((left, right) => left.path.localeCompare(right.path));

  console.log(
    `${bold(path.basename(folder))} ${dim(`this folder -> v${against.sequence}`)}`,
  );
  let differing = 0;
  for (const one of changed) {
    const wasSaved = Object.prototype.hasOwnProperty.call(saved, one.path);
    const kind: TreeChange["kind"] = one.deleted
      ? "removed"
      : wasSaved
        ? "changed"
        : "added";
    differing += 1;
    console.log(`${MARK[kind]} ${one.path}`);
    if (nameOnly || kind !== "changed") continue;
    if (one.binary) {
      console.log(dim("    not text"));
      continue;
    }
    const [before, after] = await Promise.all([
      fileTextAt(project.id, against.id, one.path),
      readFile(path.join(folder, one.path), "utf8").catch(() => null),
    ]);
    if (before === null || after === null || !isText(after)) {
      console.log(dim("    not text"));
      continue;
    }
    printHunks(before, after, context);
  }
  if (!differing) {
    console.log("This folder matches the saved version.");
    return 0;
  }
  const many = differing === 1 ? "" : "s";
  console.log(dim(`\n${differing} file${many} differ${many ? "" : "s"}`));
  return 0;
}
