/**
 * Lines of work, from a terminal.
 *
 * The desktop grew tracks — a project can have more than one line, so two
 * people can save without one of them landing on top of the other — and the
 * command line was left knowing only how to finish a merge somebody else had
 * started. It could see the wreckage and not the thing that caused it: no way
 * to list the lines, none to start one, and no way to say which line a save
 * was meant for. A folder driven from a terminal could only ever write to the
 * default.
 *
 * The service and the desktop already agree about all of this; what follows
 * is the same three ideas said in a shell. The `Tracks` client is the
 * desktop's own, imported rather than reimplemented, because two clients for
 * one API is two sets of behaviour to keep in step.
 */

import process from "node:process";

import { Tracks, type Track } from "../../cbx/src/core/tracks.js";

import { credentials, readLink, writeLink } from "./config.js";
import type { Parsed } from "./registry.js";
import { resolveProject } from "./project_commands.js";

const dim = (value: string) => `[2m${value}[0m`;
const bold = (value: string) => `[1m${value}[0m`;
const red = (value: string) => `[31m${value}[0m`;
const green = (value: string) => `[32m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;

/** The line a folder saves to when nobody has said otherwise. */
export const DEFAULT_TRACK = "main";

function client(): Tracks {
  return new Tracks(credentials);
}

/**
 * Which line this folder is on.
 *
 * Read from the folder's own record rather than from the account, because it
 * is a fact about this copy: two checkouts of the same project can sit on
 * different lines, which is most of the point of having them.
 */
export async function trackFor(localPath: string): Promise<string> {
  const link = await readLink(localPath);
  return link?.track?.trim() || DEFAULT_TRACK;
}

function describe(track: Track, current: string): string {
  const here = track.name === current;
  const mark = here ? accent("*") : " ";
  const name = here ? bold(track.name) : track.name;
  const notes: string[] = [];
  if (track.kind === "merge") notes.push("waiting on a decision");
  if (track.protected) notes.push("protected");
  if (!track.headVersionId) notes.push("nothing saved yet");
  return `${mark} ${name}${notes.length ? dim(`  ${notes.join(" · ")}`) : ""}`;
}

/**
 * Every line and unfinished merge on the project.
 *
 * Merges are listed beside the lines rather than hidden, because a merge is
 * a line the service is holding open until somebody decides — and somebody
 * looking for "where can I save" needs to see the one they cannot.
 */
export async function commandTracks(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const tracks = await client().list(project.id);
  if (!tracks.length) {
    console.log(
      dim("No lines recorded yet. The first save creates ") + bold(DEFAULT_TRACK) + dim("."),
    );
    return 0;
  }

  const current = await trackFor(process.cwd());
  const lines = tracks.filter((track) => track.kind === "line");
  const merges = tracks.filter((track) => track.kind === "merge");

  console.log(bold(`Lines on ${project.slug}`));
  for (const track of lines) console.log(`  ${describe(track, current)}`);
  if (merges.length) {
    console.log("");
    console.log(bold("Waiting on a decision"));
    for (const track of merges) console.log(`  ${describe(track, current)}`);
    console.log(dim("  Finish one with ") + "cbx merge");
  }
  console.log("");
  console.log(dim("This folder saves to ") + accent(current));
  return 0;
}

/**
 * Show, switch, or start the line this folder saves to.
 *
 * Switching is a statement about where the next save goes and nothing else:
 * no files move and nothing is fetched, which is why it is instant and why
 * it is safe to change your mind. Getting the other line's files is
 * `cbx get`, deliberately a separate act.
 */
export async function commandTrack(parsed: Parsed): Promise<number> {
  const folder = process.cwd();
  const link = await readLink(folder);
  if (!link) {
    console.error(
      red("This folder is not linked to a project. Run ") + "cbx get" + red(" first."),
    );
    return 1;
  }

  const wanted = parsed.positional[0];
  const current = link.track?.trim() || DEFAULT_TRACK;

  if (!wanted) {
    console.log(accent(current));
    console.log(dim("Switch with ") + "cbx track <name>");
    return 0;
  }

  const starting = parsed.flags.has("new") || parsed.flags.has("n");
  const tracks = await client().list(link.repositoryId);
  const existing = tracks.find((track) => track.name === wanted);

  if (existing && starting) {
    console.error(red(`There is already a line called "${wanted}".`));
    return 1;
  }

  if (!existing && !starting) {
    /*
      Refused rather than created quietly. A typo in a branch name is a
      normal thing to do, and silently starting a line called `mian` puts
      work somewhere nobody will look for it.
    */
    console.error(red(`No line called "${wanted}" on this project.`));
    console.error(dim("Start one with ") + `cbx track ${wanted} --new`);
    return 1;
  }

  if (existing?.kind === "merge") {
    console.error(
      red(`"${wanted}" is a merge waiting on a decision, not a line to save onto.`),
    );
    console.error(dim("Finish it with ") + "cbx merge");
    return 1;
  }

  if (starting) {
    try {
      await client().create(link.repositoryId, wanted);
    } catch (error) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    console.log(green(`Started ${bold(wanted)} from where the project is now.`));
  }

  await writeLink(folder, { ...link, track: wanted });
  console.log(dim("This folder now saves to ") + accent(wanted));
  if (existing) {
    console.log(
      dim("Its files are not here yet — fetch them with ") + `cbx get`,
    );
  }
  return 0;
}
