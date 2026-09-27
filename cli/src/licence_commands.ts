/**
 * Choosing a licence, and borrowing somebody else's ignore rules.
 *
 * Both are the same shape of problem: a thing every project needs, that
 * almost nobody writes from scratch, and that is quietly consequential when
 * it is missing. A project with no licence cannot legally be used by anybody,
 * however public it is — and a project with no ignore rules publishes a
 * dependency tree and whatever else was lying in the folder.
 *
 * Neither is invented here. The licence texts come from SPDX and the ignore
 * templates from github/gitignore, vendored by scripts in the desktop package
 * so that the wording matches what every other tool in the world agrees on.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_LICENCE,
  LICENCES,
  LICENCE_FILE,
  licenceById,
  licenceNewProject,
  licenceText,
  type LicenceShape,
} from "../../cbx/src/core/licences.js";
import { IGNORE_TEMPLATES } from "../../cbx/src/core/ignore_templates.js";
import { readRules, writeRules } from "../../cbx/src/core/worktree.js";
import { whoami } from "./api.js";
import type { Parsed } from "./registry.js";

const dim = (value: string) => `[2m${value}[0m`;
const bold = (value: string) => `[1m${value}[0m`;
const red = (value: string) => `[31m${value}[0m`;
const green = (value: string) => `[32m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;

const SHAPES: Record<LicenceShape, string> = {
  permissive: "Do what you like, keep the notice",
  "weak-copyleft": "Changes to these files come back",
  copyleft: "Anything built on it carries the same terms",
  "public-domain": "Given away entirely",
};

/** The file a licence goes in, matching what every tool looks for. */
/**
 * The folder a command acts on.
 *
 * Indexed the way the rest of the command line does: positional[0] is the
 * first argument after the command name, so a licence command reads its
 * licence there and its folder one along.
 */
function folderFor(parsed: Parsed, index = 0): string {
  return path.resolve(parsed.positional[index] ?? process.cwd());
}

export async function commandLicence(parsed: Parsed): Promise<number> {
  const wanted = parsed.positional[0];
  const folder = folderFor(parsed, 1);

  if (!wanted) {
    const existing = await readFile(path.join(folder, LICENCE_FILE), "utf8")
      .then((text) => text.split("\n")[0]?.trim() ?? "")
      .catch(() => null);
    if (existing !== null) {
      console.log(`${bold("This folder has a licence")} — ${existing}`);
      console.log(dim(`  ${path.join(folder, LICENCE_FILE)}`));
      console.log("");
    }

    console.log(bold("Licences you can put on this project"));
    let shape: LicenceShape | null = null;
    for (const licence of LICENCES) {
      if (licence.shape !== shape) {
        shape = licence.shape;
        console.log("");
        console.log(dim(`  ${SHAPES[shape].toUpperCase()}`));
      }
      const mark = licence.id === DEFAULT_LICENCE ? accent(" ·") : "  ";
      console.log(`${mark} ${bold(licence.id.padEnd(20))} ${licence.name}`);
      console.log(`     ${dim(licence.summary)}`);
    }
    console.log("");
    console.log(
      `Add one with ${accent("cbx licence MIT")}. ` +
        dim(`Nothing is written until you name one.`),
    );
    return 0;
  }

  /*
    "none" is a real answer, and has to be, or the default below is a trap:
    somebody who does not want their work reusable needs a way to say so that
    is as easy as the way it arrived.
  */
  if (wanted.toLowerCase() === "none") {
    const target = path.join(folder, LICENCE_FILE);
    const already = await readFile(target, "utf8").catch(() => null);
    if (already === null) {
      console.log("There is no licence here to remove.");
      return 0;
    }
    await rm(target);
    console.log(green(`Removed ${LICENCE_FILE}.`));
    console.log(
      dim("With no licence, nobody else may legally use this — which is a"),
    );
    console.log(dim("position you can hold, as long as you are holding it on purpose."));
    return 0;
  }

  const licence = licenceById(wanted);
  if (!licence) {
    console.error(red(`No licence called ${wanted}.`));
    console.error(`Run ${accent("cbx licence")} to see the list.`);
    return 1;
  }

  /*
    Whose name goes on it.

    Asked of the account rather than guessed from the folder, and only for the
    licences that carry a copyright line. Getting this wrong is not a typo —
    it is a legal document naming the wrong person — so a licence that needs a
    holder and cannot find one stops rather than writing "unknown".
  */
  let holder = flagValue(parsed, "holder") ?? "";
  if (licence.personalised && !holder) {
    holder = await whoami()
      .then((account) => account.displayName || account.username || "")
      .catch(() => "");
    if (!holder) {
      console.error(red("Could not work out whose name goes on the licence."));
      console.error(
        `Sign in, or pass ${accent('--holder "Your Name"')} to say directly.`,
      );
      return 1;
    }
  }

  const target = path.join(folder, LICENCE_FILE);
  const already = await readFile(target, "utf8").catch(() => null);
  if (already !== null && !parsed.flags.has("force")) {
    console.error(red("This folder already has a LICENSE."));
    console.error(dim(`  ${already.split("\n")[0]?.trim() ?? ""}`));
    console.error(
      `\nReplacing a licence changes the terms other people already received.` +
        `\nPass ${accent("--force")} if that is what you mean.`,
    );
    return 1;
  }

  await writeFile(target, licenceText(licence.id, holder), "utf8");
  console.log(green(`Wrote ${licence.name} to ${LICENCE_FILE}.`));
  if (licence.personalised) console.log(dim(`  in the name of ${holder}`));
  console.log(dim(`  ${licence.summary}`));
  console.log("");
  console.log(
    dim("It is a file like any other, so it goes up with your next save."),
  );
  return 0;
}

/**
 * Borrow a set of ignore rules somebody else already worked out.
 *
 * Appended under a heading of its own rather than replacing what is there.
 * A folder often needs two or three of these — a language, an editor, an
 * operating system — and a template that overwrote the last one would make
 * the second choice undo the first.
 */
export async function commandIgnoreTemplate(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  const wanted = flagValue(parsed, "template") ?? "";

  if (!wanted || wanted === "list") {
    const names = Object.values(IGNORE_TEMPLATES)
      .map((template) => template.name)
      .sort((left, right) => left.localeCompare(right));
    console.log(bold(`${names.length} sets of ignore rules`));
    console.log("");
    /* Four columns, because a list this long as one column is unreadable. */
    const width = Math.max(...names.map((name) => name.length)) + 2;
    const perRow = Math.max(1, Math.floor(96 / width));
    for (let at = 0; at < names.length; at += perRow) {
      console.log(
        "  " + names.slice(at, at + perRow).map((name) => name.padEnd(width)).join(""),
      );
    }
    console.log("");
    console.log(
      `Add one with ${accent("cbx ignore --template Python")}. ` +
        dim("Several is normal — a language, an editor, an operating system."),
    );
    return 0;
  }

  const template = IGNORE_TEMPLATES[wanted.toLowerCase()];
  if (!template) {
    console.error(red(`No rules called ${wanted}.`));
    console.error(
      `Run ${accent("cbx ignore --template list")} to see what there is.`,
    );
    return 1;
  }

  const rules = await readRules(folder);
  const heading = `# ${template.name}, from github/gitignore`;
  if (rules.shared.includes(heading)) {
    console.log(`${template.name} is already in this folder's rules.`);
    return 0;
  }
  const body = rules.shared.replace(/\s*$/, "");
  const shared = `${body ? `${body}\n\n` : ""}${heading}\n${template.body}`;
  await writeRules(folder, { ...rules, shared });

  const lines = template.body.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
  console.log(green(`Added ${template.name} — ${lines.length} rules.`));
  console.log(dim(`  ${path.join(folder, ".gitignore")}`));
  console.log("");
  console.log(
    dim(`See what it leaves behind with `) + accent("cbx status"),
  );
  return 0;
}

function flagValue(parsed: Parsed, name: string): string | null {
  const value = parsed.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/* Re-exported so the submit path has one import for all of this. */
export { licenceNewProject };
