/**
 * The project commands that had no home in the original CLI.
 *
 * Kept beside the main file rather than inside it. `cli.ts` was already 1,400
 * lines of argument handling and worktree logic, and the commands here are
 * about a project on the account rather than a folder on the disk — a
 * different subject, and one that will keep growing as more of the service
 * becomes reachable from a terminal.
 */

import process from "node:process";
import { createInterface } from "node:readline/promises";

import {
  aiAccess,
  findProject,
  findPublicProject,
  updateProject,
  versions,
  whoami,
  type AccountProject,
} from "./api.js";
import { readLink, siteOrigin } from "./config.js";
import type { Parsed } from "./registry.js";
import { accent, bold, dim, green, red } from "./colour.js";


function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

/**
 * Which project a command is about.
 *
 * Named explicitly, or the one this folder is linked to. Falling back to the
 * folder is what makes these usable from inside a project without repeating
 * its name every time.
 */
export async function resolveProject(reference: string | undefined) {
  /* Inside a run, the project it is running for (CODEROOK_PROJECT, handed to every run). */
  const wanted = reference ?? (await readLink(process.cwd()))?.slug ?? process.env.CODEROOK_PROJECT?.trim();
  if (!wanted) {
    console.error(
      red("Which project? Name one, or run this inside a linked folder."),
    );
    return null;
  }
  const project = await findProject(wanted);
  if (!project) {
    console.error(red(`No project matching "${wanted}" on your account.`));
    return null;
  }
  return project;
}

/** The answers, in the order the site shows them. */
const AI_SWITCHES = [
  [
    "read",
    "aiRead",
    "Can AI read this?",
    "reading, indexing, summarising and quoting in answers",
  ],
  [
    "train",
    "aiTrain",
    "Can AI train on this?",
    "using what it reads to train a model",
  ],
  [
    "download",
    "aiDownload",
    "Can AI download this?",
    "taking the files, one at a time or as an archive",
  ],
  [
    "contribute",
    "aiContribute",
    "Can AI contribute to this?",
    "automated clients opening contributions",
  ],
  [
    "request",
    "aiRequest",
    "Can AI make requests?",
    "automated clients calling this project's endpoints",
  ],
] as const;

/**
 * The flags `cbx ai` used to take, named when somebody types one.
 *
 * Returned rather than printed so the refusal can be checked without a
 * service: it must happen before anything is asked of one.
 */
export function aiChangeAttempted(parsed: Parsed): string[] {
  return AI_SWITCHES.map(([name]) => name).filter((name) => parsed.flags.has(name));
}

/**
 * Show what a project says about machines.
 *
 * Read only. What AI may do with a project is changed by a person, on the
 * website or in the desktop app, and the service refuses the change from any
 * token — which is what this tool, the MCP servers, runs and assistants all
 * hold. An assistant able to switch off the rule that keeps it out would make
 * the rule decoration, so the old switches are refused here, plainly, before
 * anything is sent.
 */
export async function commandAi(parsed: Parsed): Promise<number> {
  const attempted = aiChangeAttempted(parsed);
  if (attempted.length) {
    console.error(
      red(`AI access cannot be changed from the command line (${attempted.map((name) => "--" + name).join(", ")}).`),
    );
    console.error(
      "A person changes it on the website, in the project's Settings → Access & AI, or in the desktop app.",
    );
    console.error(dim("  cbx ai shows what it is set to now."));
    return 1;
  }

  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const access = await aiAccess(project.id);
  console.log("");
  console.log(bold(project.name));
  for (const [, field, question, meaning] of AI_SWITCHES) {
    const mark = access[field] ? green("allowed") : red("refused");
    console.log(`  ${question.padEnd(30)} ${mark}`);
    console.log(`  ${dim(meaning)}`);
  }
  console.log("");
  console.log(
    dim(
      "Everything but training is allowed until somebody says otherwise; training",
    ),
  );
  console.log(dim("is refused until the owner allows it, and reading off refuses it too."));
  console.log(
    dim("Change these on the website (Settings → Access & AI) or in the desktop app."),
  );
  return 0;
}

/**
 * Who can reach a project, in the order the site shows them.
 *
 * The service calls the middle one `unlisted` and the website calls it "Link
 * only"; both are accepted, and the prose uses the website's words.
 */
const LEVELS = [
  ["private", "private", "you and the people you invite"],
  [
    "unlisted",
    "link only",
    "not listed anywhere; any account signed in with its link can read it",
  ],
  [
    "public",
    "public",
    "listed on your profile and in search; its page offers the named versions",
  ],
] as const;

export type Level = (typeof LEVELS)[number][0];

const wordFor = (level: Level) =>
  LEVELS.find(([name]) => name === level)?.[1] ?? level;

/** A typed word as a level, or null when it is not one. */
export function readLevel(word: string | undefined): Level | null {
  const text = (word ?? "").trim().toLowerCase();
  if (text === "link" || text === "link-only") return "unlisted";
  const found = LEVELS.find(([name]) => name === text);
  return found ? found[0] : null;
}

/**
 * `[level] [project]`, both optional.
 *
 * The level is recognised by being one, so `cbx visibility my-project` asks
 * and `cbx visibility public` changes. Two words where the first is not a
 * level is a mistyped level rather than a project, and is said so — reading
 * it as a project would answer "no project matching" to somebody who typed
 * "pubic".
 */
export function splitVisibility(positional: string[]): {
  level?: Level;
  project?: string;
  error?: string;
} {
  const [first, second] = positional;
  const level = readLevel(first);
  if (level) return { level, project: second };
  if (second !== undefined) {
    return {
      error: `"${first}" is not a visibility. Pick public, unlisted or private.`,
    };
  }
  return { project: first };
}

/**
 * The versions a public page offers, by the service's own rule.
 *
 * Named, not hidden, finished arriving and not taken down — the four things
 * `public_rule.ts` asks. Counted here so the question before a project goes
 * public can say what the page will show rather than describe it.
 */
export function offeredPublicly<
  T extends {
    name: string | null;
    visibility: string;
    state: string;
    removedAt: string | null;
  },
>(saved: T[]): T[] {
  return saved.filter(
    (one) =>
      Boolean(one.name) &&
      one.visibility === "public" &&
      one.state === "verified" &&
      !one.removedAt,
  );
}

/**
 * The public page's address, once it answers.
 *
 * Asked of the service rather than assembled, because the page lives under
 * the owner's name and the owner is not always the person running this — a
 * collaborator can open up somebody else's project. A link is printed only
 * when the public side has confirmed it is the same project.
 */
async function publicAddress(project: AccountProject): Promise<string | null> {
  const site = siteOrigin();
  if (!site) return null;
  const me = await whoami().catch(() => null);
  if (!me?.username) return null;
  const found = await findPublicProject(me.username, project.slug);
  if (found?.id !== project.id) return null;
  return `${site}/${encodeURIComponent(me.username)}/${encodeURIComponent(project.slug)}`;
}

/** A plain yes or no, where anything but yes is no. */
export async function agreed(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const typed = await prompt.question(question);
  prompt.close();
  return /^y(es)?$/i.test(typed.trim());
}

/**
 * Show or change who can reach a project.
 *
 * Opening one up asks first and says what becomes readable, because that is
 * the step that cannot be taken back — somebody may already have read it by
 * the time it is private again. Closing one asks nothing: it takes nothing
 * from anybody who should have it.
 */
export async function commandVisibility(parsed: Parsed): Promise<number> {
  const asked = splitVisibility(parsed.positional);
  if (asked.error) {
    console.error(red(asked.error));
    return 1;
  }
  const project = await resolveProject(asked.project);
  if (!project) return 1;
  const current = readLevel(project.visibility) ?? "private";

  if (!asked.level) {
    console.log(`${bold(project.name)} is ${accent(wordFor(current))}.`);
    for (const [level, , meaning] of LEVELS) {
      const mark = level === current ? accent("›") : " ";
      console.log(`  ${mark} ${level.padEnd(9)} ${dim(meaning)}`);
    }
    if (current === "public") {
      const address = await publicAddress(project);
      if (address) console.log(`\n  ${address}`);
    }
    console.log("");
    console.log(
      dim(
        `Change it with: cbx visibility <level>` +
          (asked.project ? ` ${asked.project}` : ""),
      ),
    );
    return 0;
  }

  const target = asked.level;
  if (target === current) {
    const address = target === "public" ? await publicAddress(project) : null;
    console.log(
      `${project.name} is already ${wordFor(target)}` +
        (address ? `: ${address}` : "."),
    );
    return 0;
  }

  const sure = parsed.flags.get("yes") === true || parsed.flags.get("y") === true;
  const asking = target !== "private" && !sure;
  /*
    Refused rather than asked when nobody can answer. A prompt on a pipe
    either hangs a script for ever or reads an empty line as no, and neither
    tells whoever wrote the script what to do about it.
  */
  if (asking && !process.stdin.isTTY) {
    console.error(
      red(`Making ${project.name} ${wordFor(target)} needs a yes, and nobody is here to give one.`),
    );
    console.error(dim("  Run it in a terminal to be asked, or add --yes."));
    return 1;
  }

  const offered =
    target === "public" ? offeredPublicly(await versions(project.id)) : [];

  if (asking) {
    if (target === "public") {
      console.log(
        `Making ${bold(project.name)} public lists it on your profile and in search.`,
      );
      if (offered.length) {
        const names = offered.slice(0, 5).map((one) => one.name).join(", ");
        const more = offered.length > 5 ? ` and ${offered.length - 5} more` : "";
        console.log(
          `  Its page offers ${offered.length} named version${offered.length === 1 ? "" : "s"}: ${names}${more}.`,
        );
      } else {
        console.log(
          "  Its page will be empty until a save is named — cbx promote does that.",
        );
      }
      console.log(dim("  Saves nobody named, and versions you hid, are not on the page."));
    } else {
      console.log(
        `Making ${bold(project.name)} link only keeps it off your profile and out of search.`,
      );
    }
    if (!(await agreed(`Make ${project.name} ${wordFor(target)}? [y/N] `))) {
      console.log(dim(`Nothing changed. ${project.name} is still ${wordFor(current)}.`));
      return 1;
    }
  }

  try {
    await updateProject(project.id, { visibility: target });
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  if (target === "public") {
    const address = await publicAddress(project);
    console.log(
      green(`${project.name} is now public`) + (address ? `: ${address}` : "."),
    );
    console.log(
      dim(
        offered.length
          ? `  Its page offers ${offered.length} named version${offered.length === 1 ? "" : "s"}.`
          : "  Its page is empty until a save is named — cbx promote does that.",
      ),
    );
  } else if (target === "unlisted") {
    console.log(green(`${project.name} is now link only.`));
    console.log(dim("  It is not listed anywhere; any account signed in with its link can read it."));
  } else {
    console.log(green(`${project.name} is now private.`));
    console.log(dim("  Only you and the people you invite can reach it."));
  }
  return 0;
}

/** Every saved version of a project, newest first. */
export async function commandVersions(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const saved = await versions(project.id);
  if (!saved.length) {
    console.log(dim("Nothing has been saved to this project yet."));
    return 0;
  }

  /*
    The same two lanes the website shows.

    A version is a commit somebody named, so the lanes are a split of one
    history rather than two histories — asking for commits gives the saves
    still waiting on that decision, and asking for versions gives the ones
    the public side can see. Neither contains the other; with no flag you get
    both, which is what this always did.
  */
  const onlyVersions = parsed.flags.get("versions") === true;
  const onlyCommits = parsed.flags.get("commits") === true;
  if (onlyVersions && onlyCommits) {
    console.error(red("Pick one: --versions or --commits, or neither for both."));
    return 1;
  }
  const lane = saved.filter((version) => {
    if (onlyVersions) return Boolean(version.name);
    if (onlyCommits) return !version.name;
    return true;
  });
  if (!lane.length) {
    console.log(
      dim(
        onlyVersions
          ? "Nothing has been made a version yet."
          : "Every save here has been made a version.",
      ),
    );
    return 0;
  }

  const withNotes = parsed.flags.get("notes") === true;
  const asked = Number(parsed.flags.get("limit") ?? 20);
  const limit = Number.isFinite(asked) && asked > 0 ? asked : 20;
  console.log(bold(project.name));
  for (const version of lane.slice(0, limit)) {
    const when = version.createdAt
      ? new Date(version.createdAt).toLocaleString()
      : "";
    /*
      What the project has made of this version, said before the numbers.

      A name, a pin and a set of labels are how somebody finds the version
      they meant among forty; the file count is how they check it once they
      have. Putting the arrangement first is the difference between a log and
      a list they organised.
    */
    const marks = [
      /* Which one the project is standing on, which is not the same as which
         one is at the top once somebody has pinned something. */
      version.head ? green("current") : "",
      version.pinned ? accent("pinned") : "",
      version.name ? bold(version.name) : "",
      version.state === "held" ? red("held") : "",
      version.state === "declined" ? dim("declined") : "",
      version.removedAt ? dim("taken down") : "",
      /*
        Said only of a version, because only a version is offered to anybody.
        A commit nobody has promoted is not hidden — it was never on offer.
      */
      version.name && version.visibility === "private" ? dim("hidden") : "",
      ...version.labels.map((label) => accent(label.name)),
    ].filter(Boolean);
    console.log(
      `  ${accent(`v${version.sequence}`).padEnd(16)} ${when.padEnd(22)}` +
        `${String(version.fileCount).padStart(5)} ${version.fileCount === 1 ? "file " : "files"}  ${bytes(version.storedSize)}` +
        (marks.length ? `  ${marks.join(" ")}` : ""),
    );
    if (version.message) console.log(`    ${dim(version.message)}`);
    /*
      Indented under the save it belongs to rather than printed flat, so a
      note of several paragraphs still reads as part of one row.
    */
    if (withNotes && version.notes?.trim()) {
      for (const line of version.notes.trim().split(/\r?\n/)) {
        console.log(`      ${line}`);
      }
    }
  }
  if (lane.length > limit) {
    console.log(
      dim(`  … ${lane.length - limit} older. Use --limit to see more.`),
    );
  }
  return 0;
}
