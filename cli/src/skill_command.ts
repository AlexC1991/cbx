/**
 * Teaching an assistant about CodeRook, in one command.
 *
 * The other route in is a plugin marketplace, and marketplaces live in git
 * repositories — which is a strange thing to require of people using a version
 * host that is deliberately not git, and stranger still when the recommended
 * host is the one this product exists as an alternative to.
 *
 * A skill is a file in a folder. The command line is already installed and
 * already knows where that folder is, so it writes it: no marketplace, no
 * clone, no second account. `cbx skill` and the assistant knows what
 * CodeRook is and how to drive it from then on, in every project.
 *
 * The skill teaches it the command line rather than the MCP server. Both work,
 * but the command line needs no configuration at all — the assistant already
 * has a shell, and a thing that works with nothing to set up is the thing most
 * people should be offered first.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { Parsed } from "./registry.js";

const dim = (value: string) => `[2m${value}[0m`;
const bold = (value: string) => `[1m${value}[0m`;
const red = (value: string) => `[31m${value}[0m`;
const green = (value: string) => `[32m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;

/**
 * The skill as it ships, found relative to this file.
 *
 * Not read from the working directory, because the command is run from
 * somebody's project and the file lives wherever npm put the package.
 */
async function shipped(): Promise<string> {
  /*
    `__dirname` rather than `import.meta.url`: this package compiles to
    CommonJS, where the latter is not available and the build refuses it.
  */
  const here = __dirname;
  /*
    Compiled to dist/cli/src, so the package root is three levels up. Tried in
    order rather than assumed, so running from source works as well as running
    from an install.
  */
  const candidates = [
    path.resolve(here, "../../../skills/coderook/SKILL.md"),
    path.resolve(here, "../../skills/coderook/SKILL.md"),
    path.resolve(here, "../skills/coderook/SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      /* try the next shape */
    }
  }
  throw new Error("The skill file is missing from this installation.");
}

/**
 * Where the assistant looks.
 *
 * Personal by default — somebody who installs this wants it in every project,
 * not only the one they happened to be standing in. `--project` writes it
 * beside the code instead, which is what to do when it should travel with the
 * repository for everybody who clones it.
 */
function destination(project: boolean): string {
  const root = project
    ? path.join(process.cwd(), ".claude")
    : path.join(os.homedir(), ".claude");
  return path.join(root, "skills", "coderook", "SKILL.md");
}

export async function commandSkill(parsed: Parsed): Promise<number> {
  const project = parsed.flags.has("project");
  const target = destination(project);

  let body: string;
  try {
    body = await shipped();
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  /*
    Overwritten without asking, because the file is ours and the only reason it
    differs is that it is an older copy. Anything a person wrote themselves
    belongs under a different name.
  */
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, "utf8");

  console.log(green("Installed the CodeRook skill."));
  console.log(dim("  ") + target);
  console.log("");
  console.log(
    project
      ? dim("Everyone who opens this project in Claude Code now has it.")
      : dim("Claude Code has it in every project on this machine."),
  );
  console.log("");
  console.log(dim("Ask for it in words — ") + accent("“save this to CodeRook”"));
  console.log(dim("or run it by name — ") + accent("/coderook"));
  console.log("");
  console.log(
    dim("Signed in? ") +
      bold("cbx whoami") +
      dim("  ·  if not: ") +
      bold("cbx sign-in"),
  );
  return 0;
}
