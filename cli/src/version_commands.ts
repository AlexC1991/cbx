/**
 * Arranging a project's versions from the terminal.
 *
 * Every one of these things could already be done — from the website, and only
 * from the website. That is the gap this closes: naming worked here, hiding
 * did not, and colouring and pinning existed nowhere. A person who works in a
 * terminal should not have to open a browser to say which version matters.
 *
 * One command does the changing, because the service takes one patch: `cbx
 * version 12 --name v2.1 --hide --pin` is a single request that either happened
 * or did not, rather than three that can half-happen.
 */


import {
  changeVersion,
  createProjectLabel,
  deleteProjectLabel,
  projectLabels,
  removeVersionContent,
  reviewVersion,
  undoTo,
  versions,
  type VersionLabel,
} from "./api.js";
import { resolveProject } from "./project_commands.js";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import type { Parsed } from "./registry.js";

/* Written out rather than imported: the same four escapes every other command
   file in here declares for itself, and a shared module for four one-line
   functions would be the only thing they all depend on. */
const dim = (value: string) => `[2m${value}[0m`;
const bold = (value: string) => `[1m${value}[0m`;
const red = (value: string) => `[31m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;
const green = (value: string) => `[32m${value}[0m`;

/**
 * Which of `[n] [project]` the arguments actually were.
 *
 * Both are optional and both are positional, so `cbx undo blog` has to be read
 * as a project and `cbx undo 41` as a save — the shape of the word is the only
 * thing that separates them. A save is digits, optionally with a leading v;
 * anything else is a project name.
 *
 * That leaves a project whose whole name is digits unreachable this way. It
 * still works as `--project 41`, and reading a bare number as a save is the
 * one that comes up.
 */
export function split(parsed: Parsed): { n?: string; project?: string } {
  const named = parsed.flags.get("project") ?? parsed.flags.get("p");
  const flagged = typeof named === "string" && named ? named : undefined;
  const [first, second] = parsed.positional;
  if (second !== undefined) return { n: first, project: flagged ?? second };
  if (first === undefined) return { project: flagged };
  if (flagged) return { n: first, project: flagged };
  return /^v?\d+$/i.test(first) ? { n: first } : { project: first };
}

/** The version somebody meant, which is usually the newest one. */
async function pick(
  repositoryId: string,
  wanted: string | undefined,
): Promise<Awaited<ReturnType<typeof versions>>[number] | null> {
  const all = await versions(repositoryId);
  if (!all.length) {
    console.error(red("This project has no versions yet."));
    return null;
  }
  /*
    The newest by number, not by position.

    The list arrives newest first today, and relying on that is how three
    callers started reporting a pinned old save as the current one when the
    order changed for a while. Asking for the largest number cannot be broken
    by how the list happens to be sorted.
  */
  if (!wanted) {
    return all.reduce((newest, one) => (one.sequence > newest.sequence ? one : newest));
  }
  const sequence = wanted.replace(/^v/i, "");
  const found = all.find((one) => String(one.sequence) === sequence);
  if (!found) {
    console.error(red(`This project has no version ${wanted}.`));
    return null;
  }
  return found;
}

const SWATCH: Record<string, string> = {
  red: "#e0574a",
  amber: "#e8a13f",
  yellow: "#e8d13f",
  green: "#5fcf8d",
  blue: "#5aa9e6",
  purple: "#a98ae0",
  pink: "#e68ab8",
  grey: "#8c968f",
  gray: "#8c968f",
};

/**
 * A colour, given either as a name or as hex.
 *
 * Names because nobody remembers hex, hex because somebody will want their own
 * exact one and being told "pick from these eight" is the kind of small refusal
 * that makes a tool feel like it is arguing.
 */
function colourOf(given: string): string | null {
  const value = given.trim().toLowerCase();
  if (SWATCH[value]) return SWATCH[value]!;
  const hex = value.startsWith("#") ? value : `#${value}`;
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

function paint(label: VersionLabel): string {
  return accent(label.name);
}


/**
 * Release info, from wherever the writer keeps it.
 *
 * `--notes "..."` is fine for a sentence and hopeless for anything real: a
 * release note has paragraphs and lists in it, and the shell trick people
 * reach for — `--notes "$(cat NOTES.md)"` — is not a thing in PowerShell or
 * cmd, which is most of this product's users. So the text can come from a
 * file, or from the editor already set up for writing commit messages.
 *
 * Returns undefined when none of them were asked for, which is different from
 * an empty string: one means leave it alone, the other means clear it.
 */
function notesFrom(parsed: Parsed): string | null | undefined {
  const inline = parsed.flags.get("notes");
  const file = parsed.flags.get("notes-file");
  const edit = parsed.flags.get("edit") === true;
  const chosen = [
    typeof inline === "string",
    typeof file === "string",
    edit,
  ].filter(Boolean).length;
  if (chosen > 1) {
    throw new Error("Use one of --notes, --notes-file or --edit, not several.");
  }
  if (typeof inline === "string") return inline;
  if (typeof file === "string") {
    try {
      return readFileSync(file, "utf8");
    } catch {
      throw new Error(`Could not read ${file}.`);
    }
  }
  /*
    --edit is answered by the caller, which has the existing text to seed the
    editor with. Nothing to report from here.
  */
  return undefined;
}

/**
 * Write in the editor this person already uses, the way git does.
 *
 * The comment lines are stripped, so the instructions at the bottom of the
 * file cannot end up published as part of the release. Quitting without
 * saving leaves the notes untouched rather than clearing them, because an
 * empty buffer is far more often a change of mind than an instruction.
 */
function writeInEditor(existing: string): string | null {
  const editor =
    process.env.CODEROOK_EDITOR ??
    process.env.VISUAL ??
    process.env.EDITOR ??
    (process.platform === "win32" ? "notepad" : "nano");
  const directory = mkdtempSync(path.join(tmpdir(), "cbx-notes-"));
  const file = path.join(directory, "RELEASE_NOTES.md");
  try {
    writeFileSync(
      file,
      `${existing}\n\n` +
        "# Write what changed in this version, in Markdown.\n" +
        "# Lines starting with # in the first column are removed.\n" +
        "# Save an empty file to leave the notes as they were.\n",
      "utf8",
    );
    /*
      No shell. Handing the arguments to one concatenates them into a command
      line without escaping, which makes the editor setting — and the path
      beside it — a place to hide a second command. An editor is a program
      and some arguments, so it is split here and run directly, which also
      means a path with a space in it survives.
    */
    const parts = editor.match(/"[^"]+"|\S+/g) ?? [editor];
    const unquote = (value: string) => value.replace(/^"|"$/g, "");
    const run = spawnSync(
      unquote(parts[0] ?? editor),
      [...parts.slice(1).map(unquote), file],
      { stdio: "inherit" },
    );
    if (run.status !== 0) return null;
    const written = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => !/^#\s/.test(line) && line !== "#")
      .join("\n")
      .trim();
    return written ? written : null;
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Read or write what a version says about itself.
 *
 * The website grew a place to write this and the terminal could only set it
 * as a one-line flag while promoting, and could not read it back at all —
 * `cbx releases` prints the first line and stops. Somebody working here could
 * publish release info but never check what they had published.
 */
export async function commandNotes(parsed: Parsed): Promise<number> {
  const which = split(parsed);
  const project = await resolveProject(which.project);
  if (!project) return 1;
  const target = await pick(project.id, which.n);
  if (!target) return 1;

  if (parsed.flags.get("clear") === true) {
    await changeVersion(project.id, target.id, { notes: null });
    console.log(green(`Cleared the notes on v${target.sequence}.`));
    return 0;
  }

  let next: string | null | undefined;
  try {
    next = notesFrom(parsed);
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  if (parsed.flags.get("edit") === true) {
    const written = writeInEditor(target.notes ?? "");
    if (written === null) {
      console.log(dim("Left as it was."));
      return 0;
    }
    next = written;
  }

  if (next === undefined) {
    /* Nothing to write, so this is a read. */
    const text = (target.notes ?? "").trim();
    if (!text) {
      console.log(
        dim(`v${target.sequence} has no notes.`) +
          dim("  Write some with --edit, --notes-file or --notes"),
      );
      return 0;
    }
    console.log(bold(`v${target.sequence}${target.name ? ` ${target.name}` : ""}`));
    console.log(text);
    return 0;
  }

  const text = (next ?? "").trim();
  await changeVersion(project.id, target.id, { notes: text ? next : null });
  console.log(
    green(
      text
        ? `Wrote the notes on v${target.sequence}.`
        : `Cleared the notes on v${target.sequence}.`,
    ),
  );
  return 0;
}

export async function commandVersion(parsed: Parsed): Promise<number> {
  const which = split(parsed);
  const project = await resolveProject(which.project);
  if (!project) return 1;
  const target = await pick(project.id, which.n);
  if (!target) return 1;

  const patch: Parameters<typeof changeVersion>[2] = {};
  const name = parsed.flags.get("name");
  if (typeof name === "string") patch.name = name;
  if (parsed.flags.get("unname") === true) patch.name = null;
  try {
    const notes = notesFrom(parsed);
    if (notes !== undefined) patch.notes = notes;
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  if (parsed.flags.get("edit") === true) {
    const written = writeInEditor(target.notes ?? "");
    if (written !== null) patch.notes = written;
  }

  if (parsed.flags.get("hide") === true) patch.visibility = "private";
  if (parsed.flags.get("show") === true) patch.visibility = "public";
  const visibility = parsed.flags.get("visibility");
  if (typeof visibility === "string") {
    if (!["private", "public"].includes(visibility)) {
      console.error(red("Visibility is private, unlisted or public."));
      return 1;
    }
    patch.visibility = visibility as "private" | "unlisted" | "public";
  }

  if (parsed.flags.get("pin") === true) patch.pinned = true;
  if (parsed.flags.get("unpin") === true) patch.pinned = false;

  const labelNames = parsed.flags.get("labels");
  if (typeof labelNames === "string") {
    const known = await projectLabels(project.id);
    const wanted = labelNames
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean);
    const ids: string[] = [];
    for (const one of wanted) {
      const found = known.find(
        (label) => label.name.toLowerCase() === one.toLowerCase(),
      );
      if (!found) {
        console.error(
          red(`This project has no "${one}" label.`) +
            dim(`  Make one with cbx labels add ${one} green`),
        );
        return 1;
      }
      ids.push(found.id);
    }
    patch.labelIds = ids;
  }
  if (parsed.flags.get("clear-labels") === true) patch.labelIds = [];

  if (!Object.keys(patch).length) {
    console.error(
      red("Say what to change.") +
        dim("  --name, --notes, --hide, --show, --visibility, --pin, --labels"),
    );
    return 1;
  }

  try {
    await changeVersion(project.id, target.id, patch);
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  const said: string[] = [];
  if (patch.name !== undefined) {
    said.push(patch.name ? `named ${accent(patch.name)}` : "name removed");
  }
  if (patch.visibility) said.push(patch.visibility);
  if (patch.pinned !== undefined) said.push(patch.pinned ? "pinned" : "unpinned");
  if (patch.labelIds) {
    said.push(patch.labelIds.length ? "labelled" : "labels cleared");
  }
  console.log(`${bold(`v${target.sequence}`)} ${said.join(", ")}.`);
  return 0;
}

export async function commandLabels(parsed: Parsed): Promise<number> {
  const action = parsed.positional[0] ?? "list";

  if (action === "list") {
    const project = await resolveProject(parsed.positional[1]);
    if (!project) return 1;
    const labels = await projectLabels(project.id);
    if (!labels.length) {
      console.log(dim("No labels yet. Make one with cbx labels add shipped green"));
      return 0;
    }
    console.log(bold(project.name));
    for (const label of labels) {
      console.log(
        `  ${paint(label).padEnd(28)} ${dim(label.colour)}` +
          (label.description ? `  ${dim(label.description)}` : ""),
      );
    }
    return 0;
  }

  if (action === "add") {
    const name = parsed.positional[1];
    const colour = parsed.positional[2] ?? "grey";
    if (!name) {
      console.error(red("Name the label: cbx labels add shipped green"));
      return 1;
    }
    const project = await resolveProject(parsed.positional[3]);
    if (!project) return 1;
    const hex = colourOf(colour);
    if (!hex) {
      console.error(
        red(`"${colour}" is not a colour.`) +
          dim(`  Try one of ${Object.keys(SWATCH).slice(0, 8).join(", ")}, or #rrggbb`),
      );
      return 1;
    }
    try {
      const made = await createProjectLabel(project.id, name, hex);
      console.log(`Added ${paint(made)} ${dim(made.colour)}.`);
    } catch (error) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    return 0;
  }

  if (action === "remove" || action === "rm") {
    const name = parsed.positional[1];
    if (!name) {
      console.error(red("Name the label to remove: cbx labels remove shipped"));
      return 1;
    }
    const project = await resolveProject(parsed.positional[2]);
    if (!project) return 1;
    const labels = await projectLabels(project.id);
    const found = labels.find(
      (one) => one.name.toLowerCase() === name.toLowerCase(),
    );
    if (!found) {
      console.error(red(`This project has no "${name}" label.`));
      return 1;
    }
    await deleteProjectLabel(project.id, found.id);
    console.log(
      `Removed ${found.name}. ` +
        dim("Versions that wore it keep everything else about them."),
    );
    return 0;
  }

  console.error(red(`Unknown: cbx labels ${action}`) + dim("  Try list, add or remove"));
  return 1;
}

/**
 * The versions a project is holding until somebody says yes.
 *
 * Listed first rather than requiring a version number, because the person
 * running this is usually asking "is there anything waiting for me" rather
 * than acting on one they already know about.
 */
export async function commandHeld(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;
  const waiting = (await versions(project.id)).filter(
    (one) => one.state === "held",
  );
  if (!waiting.length) {
    console.log(dim("Nothing is waiting for a decision."));
    return 0;
  }
  console.log(bold(`${waiting.length} waiting on ${project.name}`));
  for (const one of waiting) {
    console.log(
      `  ${accent(`v${one.sequence}`).padEnd(16)} ${one.authorName.padEnd(20)} ` +
        dim(one.message),
    );
  }
  console.log(dim(`\n  cbx review v${waiting[0]!.sequence} --approve`));
  return 0;
}

export async function commandReview(parsed: Parsed): Promise<number> {
  const which = split(parsed);
  const approve = parsed.flags.get("approve") === true;
  const decline = parsed.flags.get("decline") === true;
  if (approve === decline) {
    console.error(red("Say which: --approve or --decline."));
    return 1;
  }
  const project = await resolveProject(which.project);
  if (!project) return 1;
  const target = await pick(project.id, which.n);
  if (!target) return 1;
  if (target.state !== "held") {
    console.error(red(`v${target.sequence} is not waiting for a decision.`));
    return 1;
  }
  const note = parsed.flags.get("note");
  try {
    await reviewVersion(
      project.id,
      target.id,
      approve ? "approve" : "decline",
      typeof note === "string" ? note : null,
    );
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  console.log(
    approve
      ? `${bold(`v${target.sequence}`)} approved. It is now the current version.`
      : `${bold(`v${target.sequence}`)} declined. It stays in the history as a version that was not accepted.`,
  );
  return 0;
}

/**
 * Take a version's content down.
 *
 * Asks first, and says exactly what will survive, because this is the one
 * command here that destroys something. The version itself stays — the list
 * keeps a gap saying what went and who removed it — and that distinction is
 * the difference between this and rewriting history.
 */
export async function commandTakeDown(parsed: Parsed): Promise<number> {
  const which = split(parsed);
  const project = await resolveProject(which.project);
  if (!project) return 1;
  const target = await pick(project.id, which.n);
  if (!target) return 1;

  const reason = parsed.flags.get("reason");
  if (parsed.flags.get("yes") !== true) {
    console.log(
      red(`This removes the files in v${target.sequence}. They do not come back.`),
    );
    console.log(
      dim(
        `  The version stays in the history as a gap saying it was removed.\n` +
          `  Add --yes when you are sure.`,
      ),
    );
    return 1;
  }
  try {
    await removeVersionContent(
      project.id,
      target.id,
      typeof reason === "string" ? reason : null,
    );
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  console.log(`${bold(`v${target.sequence}`)} taken down.`);
  return 0;
}

/**
 * Turning a commit into a version.
 *
 * A project's history is its working history — most of it says "fix that
 * file", and none of that is anybody else's business. A version is a commit
 * somebody decided was worth showing, and this is where that decision gets
 * made: the last ten, pick one, name it.
 *
 * Named rather than numbered on purpose. A version people fetch is "v2.1" or
 * "the one for the client", and inventing a second counter beside the commit
 * numbers would give everybody two numbers to hold and tell them nothing.
 */
export async function commandPromote(parsed: Parsed): Promise<number> {
  const which = split(parsed);
  const project = await resolveProject(which.project);
  if (!project) return 1;
  const all = await versions(project.id);
  if (!all.length) {
    console.error(red("This project has nothing saved yet."));
    return 1;
  }

  const named = parsed.flags.get("name");
  const notes = parsed.flags.get("notes");

  /* A number given outright skips the list, for anybody scripting this. */
  const asked = which.n;
  let target = asked
    ? all.find((one) => String(one.sequence) === asked.replace(/^v/i, ""))
    : null;
  if (asked && !target) {
    console.error(red(`This project has no ${asked}.`));
    return 1;
  }

  if (!target) {
    const recent = all.filter((one) => one.state === "verified").slice(0, 10);
    if (!recent.length) {
      console.error(red("Nothing here can be promoted yet."));
      return 1;
    }
    console.log(bold(`Recent commits on ${project.name}`));
    recent.forEach((one, at) => {
      const when = one.createdAt
        ? new Date(one.createdAt).toLocaleString()
        : "";
      const already = one.name ? accent(`  → ${one.name}`) : "";
      console.log(
        `  ${String(at + 1).padStart(2)}. ${accent(`v${one.sequence}`).padEnd(16)}` +
          `${when.padEnd(22)}${dim(one.message)}${already}`,
      );
    });
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const typed = await prompt.question("\nWhich one? (1-" + recent.length + ", or blank to stop) ");
    prompt.close();
    const choice = Number(typed.trim());
    if (!typed.trim()) {
      console.log(dim("Nothing promoted."));
      return 0;
    }
    if (!Number.isInteger(choice) || choice < 1 || choice > recent.length) {
      console.error(red("That was not one of the numbers listed."));
      return 1;
    }
    target = recent[choice - 1]!;
  }

  let versionName = typeof named === "string" ? named.trim() : "";
  if (!versionName) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const typed = await prompt.question(
      `Call it what? (blank for v${target.sequence}.0) `,
    );
    prompt.close();
    versionName = typed.trim() || `v${target.sequence}.0`;
  }

  try {
    await changeVersion(project.id, target.id, {
      name: versionName,
      ...(typeof notes === "string" ? { notes } : {}),
    });
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  console.log(
    `${bold(versionName)} is now a version. ` +
      dim("It is what the public side of this project offers."),
  );
  return 0;
}

/**
 * Putting the project back where it was.
 *
 * Hiding a bad push stops strangers reading it and leaves everybody on the
 * team standing on it. This moves the project itself, which is the half that
 * was missing — and it destroys nothing: the commits that get passed over stay
 * in the history with their numbers, and a later save carries on from here.
 */
export async function commandUndo(parsed: Parsed): Promise<number> {
  const which = split(parsed);
  const project = await resolveProject(which.project);
  if (!project) return 1;

  const all = await versions(project.id);
  if (all.length < 2) {
    console.error(red("There is nothing before this to go back to."));
    return 1;
  }

  let to: string | null = null;
  const asked = which.n;
  if (asked) {
    const wanted = all.find(
      (one) => String(one.sequence) === asked.replace(/^v/i, ""),
    );
    if (!wanted) {
      console.error(red(`This project has no ${asked}.`));
      return 1;
    }
    to = wanted.id;
  }

  try {
    const undone = await undoTo(project.id, to);
    console.log(
      `${bold(project.name)} is back on ${accent(`v${undone.to.sequence}`)}.`,
    );
    if (undone.skipped.length) {
      /*
        Named rather than counted. "3 commits passed over" tells somebody
        nothing they can act on; the numbers let them look at one, or promote
        one, or put the head back where it was.
      */
      console.log(
        dim(
          `  Passed over: ${undone.skipped
            .map((one) => `v${one.sequence}${one.name ? ` (${one.name})` : ""}`)
            .join(", ")}`,
        ),
      );
      console.log(
        dim("  They are still here. Nothing was deleted and nothing renumbered."),
      );
      const stillPublic = undone.skipped.filter((one) => one.name);
      if (stillPublic.length) {
        console.log(
          dim(
            `  ${stillPublic.map((one) => one.name).join(", ")} ` +
              `${stillPublic.length === 1 ? "is" : "are"} still a published version — ` +
              `use cbx mark to take ${stillPublic.length === 1 ? "it" : "them"} down.`,
          ),
        );
      }
    }
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  return 0;
}
