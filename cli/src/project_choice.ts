/*
  Which project an unlinked folder's first save goes into, decided by the
  person rather than by a name that happens to match.

  Shared by `cbx submit` and a local history's first `cbx push`: both used to
  name the project after the folder, join it if the account already had one
  of that name, and start a new one otherwise, without a word either way.
*/
import { createInterface } from "node:readline/promises";
import process from "node:process";

import { findProject, projects, type AccountProject } from "./api.js";
import { credentials } from "./config.js";
import { pathsPresent, similarProjects, slugFor, type Likeness } from "./folder_match.js";
import { Downloader } from "../../cbx/src/core/download.js";

const ESC = String.fromCharCode(27);
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (value: string) =>
  colour ? `${ESC}[${code}m${value}${ESC}[0m` : value;
const dim = paint("2");
const red = paint("31");
const accent = paint("33");

/**
 * One line about a project an unlinked folder might be, with how much of it
 * is here: the number that tells a stale copy from a separate project.
 */
export async function likenessLine(folder: string, like: Likeness, width: number): Promise<string> {
  const { project } = like;
  let here = "";
  if (project.versionCount) {
    try {
      const downloader = new Downloader(credentials);
      const latest = (await downloader.versions(project.id))[0];
      if (latest) {
        const paths = (await downloader.files(project.id, latest.id)).map((file) => file.path);
        here = ` · ${pathsPresent(folder, paths)} of its ${paths.length} files are here at the same path`;
      }
    } catch {
      /* The list is still worth showing without the count. */
    }
  }
  return (
    `${accent(project.slug.padEnd(width))}  v${project.versionCount}` +
    dim(`${here}${like.sameName ? " · same name as this folder" : ""}`)
  );
}

export type ChoiceInput = {
  folder: string;
  /** What the new project would be called: `--name`, or the folder's name. */
  name: string;
  into?: string;
  startNew: boolean;
  /** The command to show in the advice, as somebody would type it. */
  command: string;
};

/**
 * `--into` and `--new` say it outright, which is what a script or an
 * assistant must do. Without either, a folder whose name is like a project
 * already on the account is asked about at a terminal and refused elsewhere,
 * with the two commands that would settle it. A name like nothing on the
 * account is a new project, as it always was.
 *
 * Returns the project to save into, a new project's name, or null to stop.
 */
export async function chooseProject(
  input: ChoiceInput,
): Promise<AccountProject | { name: string } | null> {
  const { folder, name, into, startNew, command } = input;
  if (into && startNew) {
    console.error(red("Pass --into or --new, not both."));
    return null;
  }
  if (into) {
    const project = await findProject(into);
    if (!project) {
      console.error(red(`No project matching "${into}" on your account.`));
      console.error(dim(`  ${accent("cbx projects")} lists them.`));
      return null;
    }
    return project;
  }

  const likes = similarProjects(await projects(), name);
  const taken = likes.find((like) => like.sameName);
  if (startNew) {
    if (!taken) return { name };
    console.error(red(`Your account already has a project called ${taken.project.slug}.`));
    console.error(
      dim("  Save into it with ") + accent(`--into ${taken.project.slug}`) +
        dim(", or give the new one another name with ") + accent("--name <name>") + dim("."),
    );
    return null;
  }
  if (!likes.length) return { name };

  const width = Math.max(...likes.map((like) => like.project.slug.length));
  const lines = await Promise.all(likes.map((like) => likenessLine(folder, like, width)));
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const say = interactive ? console.log : console.error;
  say(
    `This folder is not linked to a project, and your account has ${likes.length === 1 ? "one" : "some"} like it:`,
  );
  lines.forEach((line, at) => say(`  ${interactive ? `${at + 1}  ` : ""}${line}`));

  if (!interactive) {
    console.error(`\nNothing was sent. Say which:`);
    console.error(`  ${accent(`${command} --into ${likes[0]!.project.slug}`)}   ${dim("save into that project")}`);
    console.error(
      `  ${accent(`${command} --new${taken ? " --name <another-name>" : ""}`)}   ${dim("start a separate project")}`,
    );
    return null;
  }

  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await reader.question(
        `\nSave into one of these (its number), start a new project (n), or stop (Enter): `,
      )
    ).trim().toLowerCase();
    const picked = Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= likes.length) {
      return likes[picked - 1]!.project;
    }
    if (answer !== "n" && answer !== "new") return null;
    if (!taken) return { name };
    const other = (await reader.question(`Name for the new project: `)).trim();
    if (!other) return null;
    if (likes.some((like) => like.project.slug === slugFor(other))) {
      console.error(red(`${slugFor(other)} is taken too.`));
      return null;
    }
    return { name: other };
  } finally {
    reader.close();
  }
}
