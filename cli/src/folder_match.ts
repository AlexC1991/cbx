/*
  Which of the account's projects a folder that is not linked might be.

  A save from an unlinked folder used to decide this alone: a project with the
  folder's name was joined without a word, and anything else started a new
  project without one either. Both went wrong on a real account. An inner
  folder called `voxai-coder` was joined to the project of the same name and
  laid a second copy of the app over its root for thirteen versions; a Linux
  machine that did not know the folder was linked started `voxai-coder-linux`
  beside it. Neither was a choice anybody made.

  So this only finds the candidates. Choosing between them is the person's.
*/
import { existsSync } from "node:fs";
import path from "node:path";

import type { AccountProject } from "./api.js";

/** The slug the service gives a name: what a new project would be called. */
export function slugFor(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project"
  );
}

export type Likeness = {
  project: AccountProject;
  /** True when a new project of this name would collide with it. */
  sameName: boolean;
};

/**
 * Projects whose name is this one, or this one with a word added or taken
 * away: `voxai-coder` finds `voxai-coder-linux`, and the other way round.
 *
 * Words, not letters. `app` is not like `apple`, and a project somebody
 * named `wallpaper-picker-backend` on purpose is offered, never assumed.
 */
export function similarProjects(all: AccountProject[], name: string): Likeness[] {
  const wanted = slugFor(name);
  const related = (slug: string) =>
    slug.startsWith(`${wanted}-`) || wanted.startsWith(`${slug}-`);
  return all
    .filter((project) => project.slug === wanted || related(project.slug))
    .map((project) => ({ project, sameName: project.slug === wanted }))
    .sort((left, right) => Number(right.sameName) - Number(left.sameName))
    .slice(0, 5);
}

/**
 * How many of a project's files are in this folder at the same path.
 *
 * Paths only, and only counted: reading every file to compare digests would
 * make the question cost a full scan, and a folder that holds most of a
 * project's paths is already the answer somebody needs to choose.
 */
export function pathsPresent(folder: string, paths: string[]): number {
  let present = 0;
  for (const file of paths) {
    if (existsSync(path.join(folder, ...file.split("/")))) present += 1;
  }
  return present;
}
