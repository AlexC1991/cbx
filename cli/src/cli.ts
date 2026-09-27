#!/usr/bin/env node
/**
 * cbx — the CodeBox engine from the command line, talking to CodeRook.
 *
 * The same engines the desktop application uses — the same scanner, the same
 * ignore rules, the same upload and download — with a terminal in front of
 * them instead of a window. Nothing here is Windows-specific, so it runs
 * wherever Node does.
 *
 * The vocabulary follows docs/REPOSITORY_MODEL.md: get latest, save a
 * version, submit it.
 */
import { createInterface } from "node:readline/promises";
import os from "node:os";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  collisionCheck,
  applyMerge,
  cancelMerge,
  mergeTrack,
  openProposal,
  proposals,
  requestReviews,
  mergeTracks,
  resolveMergeConflict,
} from "./api.js";
import {
  buildRegistry,
  nearestCommand,
  type CommandSpec,
} from "./registry.js";
import { renderCommandHelp, renderHelp, renderUnknown } from "./help.js";
import { bar } from "./progress.js";
import { classifyPublishFailure, uploadRequestFor } from "./publish.js";
import { commandAttach } from "./attach_command.js";
import { commandPages } from "./pages_command.js";
import {
  commandAi,
  commandVersions,
  commandVisibility,
} from "./project_commands.js";
import {
  commandTrack,
  commandTracks,
  trackFor,
} from "./track_commands.js";
import { Tracks } from "../../cbx/src/core/tracks.js";
import { commandTransfer } from "./transfer_command.js";
import { commandMcp } from "./mcp.js";
import { commandSkill } from "./skill_command.js";
import {
  commandIgnoreTemplate,
  commandLicence,
  licenceNewProject,
} from "./licence_commands.js";
import {
  commandCollaborators,
  commandDelete,
  commandHooks,
  commandIssues,
  commandLogs,
  commandRuns,
  commandRelease,
  commandReleases,
  commandTokens,
  commandWatch,
  commandWorkflows,
} from "./service_commands.js";
import {
  changedFiles,
  detectPastedCredentials,
  detectPrivateDirectories,
  detectSecrets,
  missingEngineRules,
  readRules,
  writeRules,
} from "../../cbx/src/core/worktree.js";
import { excludes, parseRules } from "../../cbx/src/core/rules.js";
import { Uploader } from "../../cbx/src/core/upload.js";
import { Downloader } from "../../cbx/src/core/download.js";
import { whyUnsafe } from "../../cbx/src/shared/safe_path.js";
import { maybeFail } from "../../cbx/src/core/faults.js";
import {
  commandHeld,
  commandNotes,
  commandPromote,
  commandLabels,
  commandReview,
  commandTakeDown,
  commandUndo,
  commandVersion,
} from "./version_commands.js";
import { declareClient } from "../../cbx/src/core/identify.js";
import { commandDiff } from "./diff_command.js";
import {
  commandInit,
  commandRestore,
  commandSave,
  localDiff,
  localFirst,
  localLog,
  localMerge,
  localPull,
  localPush,
  localStatus,
  localSwitch,
} from "./local_commands.js";
import { profileReport } from "../../cbx/src/core/profile.js";
import {
  rulesFromSuggestions,
  suggestExclusions,
} from "../../cbx/src/core/detect.js";
import {
  packBundle,
  readManifest as readBundleManifest,
  unpackBundle,
} from "../../cbx/src/core/cbx.js";
import { findProject, health, projectById, projects, whoami } from "./api.js";
import {
  fetchSnapshot,
  gitAvailable,
  humanBytes,
  looksLikeRepositoryUrl,
  measure,
} from "./import_command.js";
import {
  claim,
  defaultLabels,
  performRun,
  report,
} from "./runner.js";
import {
  clearToken,
  configDirectory,
  credentials,
  loadToken,
  readDigests,
  readLink,
  storeToken,
  writeDigests,
  forgetLink,
  writeLink,
  type Link,
} from "./config.js";

import { VERSION } from "./version.js";

/*
  Said once, before anything reaches the service. The version comes from the
  package rather than a constant, so it cannot drift from what was published
  and claim a behaviour this build does not have.
*/
declareClient("cli", VERSION);

// ── presentation ────────────────────────────────────────────────────────────

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (text: string) => (colour ? `[2m${text}[0m` : text);
const bold = (text: string) => (colour ? `[1m${text}[0m` : text);
const accent = (text: string) => (colour ? `[33m${text}[0m` : text);
const red = (text: string) => (colour ? `[31m${text}[0m` : text);
const green = (text: string) => (colour ? `[32m${text}[0m` : text);

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

/** One line that rewrites itself, so progress does not scroll the terminal. */
function progressLine(): (text: string) => void {
  let last = 0;
  return (text: string) => {
    if (!process.stdout.isTTY) return;
    /*
      Measured without the colour codes. Padding to the raw length of a string
      carrying escape sequences overshoots by however many invisible
      characters it holds, which drags the cursor past the end of the line.
    */
    const visible = text.replace(/\[[0-9;]*m/g, "").length;
    const padded = text + " ".repeat(Math.max(0, last - visible));
    last = visible;
    process.stdout.write(`\r${padded}`);
  };
}

/** The shared bar, drawn from a percentage and this session's colour setting. */
const track = (percent: number) => bar(percent / 100, 18, dim);

const done = (line: (text: string) => void) => {
  if (process.stdout.isTTY) {
    line("");
    process.stdout.write("\r");
  }
};

// ── arguments ───────────────────────────────────────────────────────────────

type Parsed = { positional: string[]; flags: Map<string, string | true> };

/**
 * The flags a command declares as taking a value.
 *
 * Read from the option's own help text, which already says so: a value is
 * written as a placeholder after the name, as in `--name <text>`, and a
 * switch has nothing after it. So there is no second list to keep in step
 * with the first — the thing already written for the reader is the thing
 * the parser uses.
 */
function valueTaking(spec: CommandSpec | undefined): Set<string> {
  const names = new Set<string>();
  for (const option of spec?.options ?? []) {
    if (!/[<[]/.test(option.flags)) continue;
    for (const match of option.flags.matchAll(/--?([A-Za-z0-9][\w-]*)/g)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/**
 * What was typed, split into positions and flags.
 *
 * A flag takes the word after it only when the command says it takes one.
 * Guessing from the shape of the next word — anything not starting with a
 * dash — meant `cbx take-down 1 --yes my-project` read the project name as
 * the value of `--yes` and then reported that `--yes` had not been given,
 * having also swallowed the argument that said which project. Every switch
 * followed by a positional had the same fault.
 */
function parse(argv: string[], spec?: CommandSpec): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const takesValue = valueTaking(spec);
  for (let at = 0; at < argv.length; at += 1) {
    const item = argv[at]!;
    if (!item.startsWith("-")) {
      positional.push(item);
      continue;
    }
    /* `--name=value` says so itself and needs no declaration. */
    const written = item.replace(/^--?/, "");
    const split = written.indexOf("=");
    if (split > 0) {
      flags.set(written.slice(0, split), written.slice(split + 1));
      continue;
    }
    const name = written;
    const next = argv[at + 1];
    /*
      An undeclared flag keeps the old guess. Commands that never declared
      their options rely on it, and narrowing that here would trade one
      quiet misreading for another.
    */
    /*
      A command that declares any options has declared them all, including
      when none of them takes a value. Keying this on the value-taking ones
      alone let `cbx switch -c spike` read "spike" as the value of `-c`.
    */
    const wants = spec?.options?.length ? takesValue.has(name) : true;
    if (wants && next !== undefined && !next.startsWith("-")) {
      flags.set(name, next);
      at += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

const flagText = (parsed: Parsed, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
};

const hasFlag = (parsed: Parsed, ...names: string[]) =>
  names.some((name) => parsed.flags.has(name));

const folderFor = (parsed: Parsed, index = 0): string =>
  path.resolve(parsed.positional[index] ?? process.cwd());

// ── shared behaviour ────────────────────────────────────────────────────────

/**
 * Reconcile a folder with the account: which repository it belongs to and
 * what that repository already holds. The account is the authority, exactly
 * as it is in the desktop application.
 */
/**
 * Work out what this folder is based on, and whether the account has moved.
 *
 * The base is the version this folder was last brought level with — not
 * whatever happens to be newest. Silently re-basing on the newest is what
 * makes a folder look up to date when somebody else has published: the
 * changes are then measured against their work, and saving quietly lays
 * this machine's copy over theirs.
 *
 * So a folder that has fallen behind keeps its own base and is told, which
 * is what lets the service merge the two rather than pick a winner.
 */
async function reconcile(
  folder: string,
  options: { quiet?: boolean } = {},
): Promise<{
  link: Link | null;
  baseline: Map<string, string> | null;
  /** The account's newest version, when it is ahead of this folder. */
  behind: { sequence: number; id: string } | null;
  /**
   * Whether this account is one of the project's people. False for a folder
   * cloned from somebody else's public or unlisted project: it can look and
   * fetch, and it cannot save.
   */
  member: boolean;
}> {
  const link = await readLink(folder);
  const reference = link?.slug ?? path.basename(folder);
  let member = true;
  let project = link
    ? (await projects()).find((candidate) => candidate.id === link.repositoryId)
    : await findProject(reference);
  /*
    Not on the account's own list, which holds only projects it is in. A
    folder cloned from somebody else's public project is exactly that, and
    it was told the project had gone. Asked by id instead, the service still
    answers for an open project and says the caller is a visitor.
  */
  if (link && !project) {
    const visited = await projectById(link.repositoryId);
    if (visited) {
      project = visited;
      member = visited.member;
    }
  }

  /*
    A link that has outlived the project it points at.

    The list above is everything this account can reach — owned, shared with
    them, and through their organisation — so a linked project missing from it
    is gone or no longer theirs. Left alone, the next call that used the
    remembered id failed with "Repository not found", which names neither the
    folder nor anything to do about it; the soak suite hit exactly this and it
    took a debugger to work out which folder was complaining.
  */
  if (link && !project) {
    throw new Error(
      `This folder is linked to a project that is no longer on your account.\n` +
        `  ${folder}\n` +
        `It may have been deleted, or your access to it withdrawn.\n` +
        `Detach the folder with ${accent("cbx unlink")} — the files here are ` +
        `untouched, and submitting afterwards starts a new project from them.`,
    );
  }

  if (!project?.versionCount) {
    // Nothing saved on the account, so everything here is outstanding.
    return { link: link ?? null, baseline: null, behind: null, member };
  }

  const downloader = new Downloader(credentials);
  const latest = (await downloader.versions(project.id))[0];
  if (!latest) return { link: link ?? null, baseline: null, behind: null, member };

  /*
    A folder that already knows which version it stands on keeps it. Only a
    folder that has never been reconciled — or was linked before versions
    were recorded — adopts the newest as its starting point.
  */
  const known = link?.baseVersionId && link.manifest ? link : null;
  const behind =
    known && known.baseVersionId !== latest.id
      ? { sequence: latest.sequence, id: latest.id }
      : null;

  if (known) {
    if (known.observedHeadVersionId !== latest.id) {
      known.observedHeadVersionId = latest.id;
      await writeLink(folder, known);
    }
    if (behind && !options.quiet) {
      console.log(
        dim(
          `The account is on v${behind.sequence}; this folder is based on v${known.sequence}.`,
        ),
      );
    }
    return {
      link: known,
      /*
        The comparison is against what this folder actually holds, not what
        the version holds. After a merge the two differ, and comparing
        against the version would read a stale copy as a fresh edit and
        push it back over the change that replaced it.
      */
      baseline: new Map(Object.entries(known.local ?? known.manifest)),
      behind,
      member,
    };
  }

  const baseline = new Map<string, string>();
  for (const file of await downloader.files(project.id, latest.id)) {
    baseline.set(file.path, file.sha256);
  }
  const fresh: Link = {
    repositoryId: project.id,
    slug: project.slug,
    sequence: latest.sequence,
    versionId: latest.id,
    baseVersionId: latest.id,
    observedHeadVersionId: latest.id,
    // Adopted whole, so the folder is taken to hold what the version holds.
    local: Object.fromEntries(baseline),
    manifest: Object.fromEntries(baseline),
  };
  await writeLink(folder, fresh);
  if (!options.quiet && !link) {
    console.log(dim(`Linked this folder to ${project.slug}.`));
  }
  return { link: fresh, baseline, behind: null, member };
}

// ── commands ────────────────────────────────────────────────────────────────

async function commandSignIn(parsed: Parsed): Promise<number> {
  const supplied = flagText(parsed, "token");
  let token = supplied ?? "";
  if (!token) {
    console.log(
      `Create a personal access token at ${dim("https://coderook.com/?screen=settings")}`,
    );
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    token = (await reader.question("Access token: ")).trim();
    reader.close();
  }
  if (!token) {
    console.error(red("No token given."));
    return 1;
  }
  await storeToken(token);
  try {
    const account = await whoami();
    console.log(
      `Signed in as ${bold(account.displayName)} ${dim(`<${account.email}>`)} · ${account.plan}`,
    );
    console.log(dim(`Token stored in ${configDirectory()}`));
    return 0;
  } catch (error) {
    await clearToken();
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

async function commandSignOut(): Promise<number> {
  await clearToken();
  console.log("Signed out on this machine.");
  return 0;
}

async function commandWhoami(): Promise<number> {
  const account = await whoami();
  console.log(`${bold(account.displayName)} <${account.email}> · ${account.plan}`);
  return 0;
}

async function commandProjects(): Promise<number> {
  const all = await projects();
  if (!all.length) {
    console.log("No projects on this account yet.");
    return 0;
  }
  const width = Math.max(...all.map((project) => project.slug.length));
  for (const project of all) {
    console.log(
      `${accent(project.slug.padEnd(width))}  v${String(project.versionCount).padEnd(4)}` +
        `${String(project.fileCount).padStart(6)} files  ${bytes(project.storedBytes).padStart(9)}` +
        `  ${dim(project.visibility)}`,
    );
  }
  return 0;
}

async function commandUnlink(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  const link = await readLink(folder);
  if (!(await forgetLink(folder))) {
    console.log("This folder was not linked to a project.");
    return 0;
  }
  console.log(
    `Detached ${bold(path.basename(folder))}` +
      (link?.slug ? dim(` from ${link.slug}`) : "") +
      ".",
  );
  console.log(
    dim(
      "Nothing was deleted. Submitting from here now starts a new project.",
    ),
  );
  return 0;
}

async function commandStatus(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  let link: Link | null;
  let baseline: Map<string, string> | null;
  try {
    ({ link, baseline } = await reconcile(folder));
  } catch (error) {
    link = await readLink(folder);
    if (!link?.manifest) throw error;
    baseline = new Map(Object.entries(link.local ?? link.manifest));
    console.log(dim("Offline — comparing with the last Version cached for this folder."));
  }
  const rules = await readRules(folder);
  /*
    Scanned the way `cbx diff` scans, and reported the way `cbx submit` acts.

    Status used to ask only for additions and updates, which is exactly what a
    plain save sends — so it was not wrong. But a deleted file then appeared
    nowhere: `cbx diff` showed it as removed, `cbx status` said nothing, and
    the two commands disagreed about the same folder. Somebody who had deleted
    a file read that as CodeRook not having noticed it.

    So deletions are found and named here, kept apart from what a save will
    send, with the flag that would send them spelled out. The safe default
    does not change: a save adds and updates.
  */
  const found = await changedFiles(folder, rules, baseline, "synchronize");
  const gone = found.filter((file) => file.deleted);
  const files = found.filter((file) => !file.deleted);

  console.log(bold(path.basename(folder)) + dim(`  ${folder}`));
  console.log(
    link
      ? `Account holds ${accent(`v${link.sequence}`)} · ${Object.keys(link.manifest).length} files ${dim(`(${link.slug})`)}`
      : dim("Not on your account yet — submitting will create it."),
  );

  /*
    A folder can have nothing to send and still not hold the whole version:
    when the service merges somebody else's save into yours, their files
    join the version without ever arriving here. Saying so is the difference
    between "you are level" and "you are level with your own work".
  */
  const stale = link?.local
    ? Object.entries(link.manifest).filter(
        ([path, digest]) => link.local![path] !== digest,
      )
    : [];
  if (stale.length) {
    console.log(
      dim(
        `${stale.length} file${stale.length === 1 ? "" : "s"} in the saved version ` +
          `${stale.length === 1 ? "is" : "are"} newer than the cop${stale.length === 1 ? "y" : "ies"} here ` +
          `— run ${accent("cbx get")} to bring ${stale.length === 1 ? "it" : "them"} down.`,
      ),
    );
    for (const [path] of stale.slice(0, 10)) console.log(dim(`  behind  ${path}`));
    /*
      Behind, and not here at all. Usually somebody else's file that has not
      been fetched — but it is also what a file deleted here looked like after
      a save that did not send the deletion, because until 0.31.2 that save
      dropped it from this folder's record. Told plainly, since the one advice
      above would bring back a file the person meant to be rid of.
    */
    const absent = stale.filter(
      ([file]) => !existsSync(path.join(folder, ...file.split("/"))),
    );
    if (absent.length) {
      const one = absent.length === 1;
      const which =
        absent.length === stale.length
          ? one ? "It is not" : "They are not"
          : `${absent.length} of them ${one ? "is" : "are"} not`;
      console.log(
        dim(
          `${which} in this folder at all. If you deleted ${one ? "it" : "them"} yourself, ` +
            `run ${accent("cbx get")}, delete ${one ? "it" : "them"} again, and save with ${accent("--sync")}.`,
        ),
      );
    }
  }

  /** The deletions, and what a plain save will do about them. */
  /*
    What this folder is, and what its own rules never heard about.

    A real .gitignore always wins — that is not negotiable — but it also meant
    that a Unity project whose file was written before the engine rules
    existed went on sending its entire import cache, and nothing anywhere
    said so. One real upload of forty-seven thousand files was forty-five
    thousand of rebuildable cache, and it broke the project on the machine it
    was downloaded to.
  */
  const engine = async () => {
    const { kind, missing } = await missingEngineRules(folder);
    if (!kind.length || !missing.length) return;
    /*
      Only the rules that would actually leave something out.

      Naming every line the template has and this folder does not produced
      sixty-odd of them, most matching nothing at all — a Visual Studio
      template mentions `[Dd]ebug/x64/` whether or not you have one. What a
      person needs is the two that are costing them forty thousand files, so
      each candidate is measured against what this folder is currently
      sending and the ones worth nothing are not mentioned.
    */
    const sending = found.map((one) => one.path);
    const worth = missing
      .map((rule) => {
        const layers = [{ base: "", rules: parseRules(rule) }];
        return {
          rule,
          files: sending.filter((one) => excludes(one, false, layers)).length,
        };
      })
      .filter((one) => one.files > 0)
      .sort((left, right) => right.files - left.files);
    if (!worth.length) return;
    const total = worth.reduce((sum, one) => sum + one.files, 0);
    console.log(
      dim(
        `\nThis looks like a ${kind.join(" + ")} project, and its own rules are ` +
          `missing ${worth.length} that would leave out ` +
          `${total.toLocaleString()} file${total === 1 ? "" : "s"} you are sending — ` +
          `${accent("cbx ignore --template " + kind[0])} adds them.`,
      ),
    );
    for (const one of worth.slice(0, 6)) {
      console.log(dim(`  ${String(one.files).padStart(7)}  ${one.rule}`));
    }
  };

  const deletions = () => {
    if (!gone.length) return;
    const many = gone.length === 1 ? "" : "s";
    console.log(
      dim(
        `\n${gone.length} file${many} deleted here ${gone.length === 1 ? "is" : "are"} ` +
          `still in the saved version. A save adds and updates, so ` +
          `${gone.length === 1 ? "it stays" : "they stay"} until you pass ` +
          `${accent("--sync")}.`,
      ),
    );
    for (const file of gone.slice(0, 10)) {
      console.log(`  ${red("deleted")}  ${file.path}`);
    }
    if (gone.length > 10) console.log(dim(`  …and ${gone.length - 10} more`));
  };

  if (!files.length) {
    console.log(
      stale.length
        ? "Nothing to submit; your own work is all saved."
        : gone.length
          ? "Nothing here to add or update."
          : "Nothing to submit; this folder matches the saved version.",
    );
    deletions();
    await engine();
    return 0;
  }
  console.log(`\n${files.length} file${files.length === 1 ? "" : "s"} to submit:`);
  for (const file of files.slice(0, 50)) {
    console.log(`  ${accent("changed")}  ${file.path}`);
  }
  if (files.length > 50) console.log(dim(`  …and ${files.length - 50} more`));
  deletions();
  await engine();
  return 0;
}

/**
 * Bring an existing repository in from another host.
 *
 * Snapshot only, and it says so. The files arrive, the history does not —
 * see `import_command.ts` for why that is a limit rather than an omission.
 * Everything after the fetch is the ordinary save path, so an import
 * produces exactly the Version that saving the same folder would.
 */
async function commandImport(parsed: Parsed): Promise<number> {
  const url = parsed.positional[0];
  if (!url) {
    console.error(red("Nothing to import from."));
    console.error("Give the address of a repository, for example:");
    console.error(`  ${accent("cbx import https://github.com/owner/project")}`);
    return 1;
  }
  if (!looksLikeRepositoryUrl(url)) {
    console.error(red(`${url} does not look like a repository address.`));
    console.error(
      "Expected something like https://github.com/owner/project or\n" +
        "git@github.com:owner/project.git",
    );
    return 1;
  }
  if (!(await gitAvailable())) {
    console.error(red("Import needs git on this machine, and it was not found."));
    console.error(
      "Git is used to fetch the files once; nothing about your project\n" +
        "afterwards depends on it.",
    );
    return 1;
  }

  const destination = parsed.positional[1] ?? null;
  let plan;
  try {
    plan = await fetchSnapshot(url, destination, (line) => console.log(dim(line)));
  } catch (error) {
    console.error(red("Could not fetch that repository."));
    const detail = error instanceof Error ? error.message : String(error);
    /*
      git puts the useful sentence last and a stack of its own noise first.
      A private repository with no credentials is by far the most common
      failure, so it is named rather than left to be inferred.
    */
    console.error(detail.split("\n").filter(Boolean).slice(-3).join("\n"));
    if (/authentication|denied|not found|could not read/i.test(detail)) {
      console.error(
        "\nIf it is private, sign in to it with git first — CodeRook uses\n" +
          "the credentials git already has and never asks for a token.",
      );
    }
    return 1;
  }

  const { files, bytes } = await measure(plan.folder);
  if (!files) {
    console.error(red("That repository has no files in it."));
    if (plan.temporary) await rm(path.dirname(plan.folder), { recursive: true, force: true });
    return 1;
  }
  console.log(
    `Fetched ${files} file${files === 1 ? "" : "s"}, ${humanBytes(bytes)}, ` +
      `into ${plan.folder}`,
  );

  /*
    Said before the upload rather than after it fails. The window is a share
    of the plan allowance per week, so a large import is a thing somebody
    should know about while they can still choose a smaller repository.
  */
  if (bytes > 1024 ** 3) {
    console.log(
      dim(
        "This is a large import. Uploads are limited to a share of your\n" +
          "allowance each week, so a project this size may need more than one\n" +
          "sitting; the save resumes rather than starting over.",
      ),
    );
  }

  console.log(dim("History is not imported — this becomes the first version."));

  /*
    Hand the fetched folder to the ordinary save path. --allow-ignored is set
    because git tracks files committed before the rule that excludes them,
    and dropping those would make the import quietly lossy.
  */
  const submitFlags = new Map(parsed.flags);
  submitFlags.set("allow-ignored", true);
  /*
    Name the project after the repository, not after wherever the files were
    put. Without this an import into a temporary folder produces a project
    called something like `tmp-4f21`, and the name is the thing somebody
    types afterwards to fetch it.
  */
  if (!submitFlags.has("name")) submitFlags.set("name", plan.name);
  if (!submitFlags.has("m") && !submitFlags.has("message")) {
    submitFlags.set("message", `Imported from ${url}`);
  }
  const code = await commandSubmit({
    positional: [plan.folder],
    flags: submitFlags,
  });

  if (code === 0 && plan.temporary) {
    console.log(
      dim(
        `The working copy stays at ${plan.folder} until you remove it.
` +
          `Run ${accent("cbx get " + plan.name)} anywhere to fetch it fresh.`,
      ),
    );
  }
  return code;
}

async function commandSubmit(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  const message = flagText(parsed, "m", "message") ?? "";
  const { link, baseline, behind, member } = await reconcile(folder);
  /*
    Somebody else's project, cloned from its public page. Reading and
    fetching are fine; saving into it is not this account's to do, and the
    service would refuse it anyway, less clearly.
  */
  if (link && !member) {
    console.error(
      red(`Access denied: you are not a collaborator on ${link.slug}.`) +
        "\n" +
        dim(
          `  Ask its owner to invite you, or run ${accent("cbx unlink")} to start a project of ` +
            "your own from these files.",
        ),
    );
    return 1;
  }

  /*
    A first save gets a licence unless it is turned down.

    Work published with no licence cannot legally be used by anybody, which is
    the opposite of what nearly everyone uploading their work intends — so the
    default says the generous thing rather than the silent one. It happens
    before the scan below so the file goes up with this same version rather
    than trailing a save behind.

    Only on a project's first save. After that an absent LICENSE is somebody's
    decision and putting one back would be arguing with them.
  */
  const added = link
    ? null
    : await licenceNewProject(
        folder,
        /*
          Whose name goes on the copyright line. Asked of the account rather
          than guessed from the folder — and when it cannot be had, the shared
          helper writes nothing rather than naming nobody.
        */
        await whoami()
          .then((account) => account.displayName || account.username || "")
          .catch(() => ""),
        hasFlag(parsed, "no-licence"),
      );

  /*
    Import sends what it fetched, filtering nothing.

    The ignore rules exist to keep build output and local mess out of a
    working folder, and applying them to a fresh clone gets the wrong answer
    twice over: a clone holds exactly the files the source repository tracked
    and nothing else, so there is no mess to exclude — while a repository
    that tracks something its own `.gitignore` now names (which git does,
    for anything committed before the rule) would have those files dropped.
    Dropping them makes an import quietly lossy, which is worse than
    refusing to import at all.
  */
  const importing = hasFlag(parsed, "allow-ignored");
  const rules = importing
    ? { shared: "", local: "" }
    : await readRules(folder);
  /*
    Whether a file that is no longer here means "delete it".

    The default says no, and that is the right default: a missing path is
    usually an unmounted drive, a folder moved while something was open, or a
    scan that ran mid-copy — and the cost of guessing wrong is somebody's work
    removed from the one place it was safe. So the saved copy is left alone
    (docs/UPLOAD_POLICY.md).

    It also meant nothing on this side could ever remove a file. Publishing
    from git can, because there the question does not arise: `git rm` is a
    recorded act, so the deletion is known rather than inferred. That left the
    remote helper as the only route to something the tool itself could not do,
    which is the wrong way round — so this is that capability, asked for
    plainly.
  */
  /*
    Digests this machine has taken before, read before the scan rather than
    before the upload.

    The uploader has always accepted these and the desktop has always passed
    them, but on the command line the expensive part happens earlier: the
    scan below reads and hashes the whole folder to decide what changed, and
    that is where a 21,071-file project spent 169 of its 299 seconds. The
    same map serves both — `changedFiles` fills it in place, so what the scan
    learns is what the upload is handed.
  */
  const knownDigests = link?.repositoryId
    ? await readDigests(link.repositoryId)
    : new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  const files = await changedFiles(
    folder,
    rules,
    baseline,
    hasFlag(parsed, "sync") ? "synchronize" : "add-and-update",
    knownDigests,
  );

  /*
    An upgraded folder with no materialisation record and something that
    differs from its recorded version is ambiguous in the one way that
    matters: the difference is either work to send, or a copy left behind by
    somebody's merge. Sending the second reverts their change.

    While the folder is level with the project the question does not arise —
    nothing can have merged underneath it — so only a folder that is behind
    is stopped, and only until somebody says which it is.
  */
  if (link && !link.local && files.length && behind) {
    if (await establishMaterialisation(folder, link)) {
      link.local = { ...link.manifest };
      await writeLink(folder, link);
    } else if (!hasFlag(parsed, "f", "force")) {
      console.error(
        red("This folder was connected by an older version of CodeRook,"),
      );
      console.error("which did not record what it had received — and somebody");
      console.error(`has saved since (the project is on v${behind.sequence}).\n`);
      console.error(`${files.length} file${files.length === 1 ? " differs" : "s differ"} here:`);
      for (const file of files.slice(0, 20)) console.error(`  ${file.path}`);
      console.error(
        `\nIf that is your work, send it with ${accent("cbx submit --force")}.` +
          `\nIf it is an old copy, take theirs with ${accent("cbx get --replace")}.`,
      );
      return 1;
    }
  }

  if (!files.length) {
    // Having nothing to send is not the same as holding the whole version:
    // a merge can leave this folder with an older copy of somebody else's
    // file. Saying so is what stops "nothing to do" from reading as "level".
    const behindOn = link?.local
      ? Object.entries(link.manifest).filter(
          ([path, digest]) => link.local![path] !== digest,
        ).length
      : 0;
    console.log(
      behindOn
        ? `Nothing to submit; your own work is all saved. ${behindOn} file` +
            `${behindOn === 1 ? "" : "s"} here ${behindOn === 1 ? "is" : "are"} ` +
            `behind the saved version — run ${accent("cbx get")}.`
        : "Nothing to submit; this folder matches the saved version.",
    );
    return 0;
  }
  /*
    The policy is that credentials are never quietly dropped and never
    quietly sent — they are asked about. The desktop application has always
    put this question in front of the first upload; the command line was
    sending them without a word, which is the worse half of the two
    behaviours the policy exists to prevent.
  */
  const secrets = await detectSecrets(folder);
  const sending = new Set(files.map((file) => file.path));
  const exposed = secrets.filter((secret) => sending.has(secret));

  /*
    Whole folders that belong to a program rather than to the work.

    The credential check answers by name, one file at a time, and cannot see
    into a dependency folder at all — which is where a real cached login sat
    while a project went up carrying a browser profile, an emulated database
    and an unrelated work tree. Naming the folder is the only answer that
    keeps working after the program next runs and rewrites what is inside it.
  */
  const shielded = (await detectPrivateDirectories(folder)).filter((finding) =>
    [...sending].some(
      (file) => file === finding.path || file.startsWith(`${finding.path}/`),
    ),
  );
  if (shielded.length && !hasFlag(parsed, "allow-private")) {
    console.log(
      red(
        `
${shielded.length} folder${
          shielded.length === 1 ? "" : "s"
        } here belong${shielded.length === 1 ? "s" : ""} to a program, not to your project:`,
      ),
    );
    for (const finding of shielded) {
      console.log(`  ${finding.path}  ${dim(`— ${finding.because}`)}`);
    }
    console.log(`
Nothing was sent. To leave them behind:`);
    for (const finding of shielded) {
      console.log(`  ${accent(`echo "${finding.rule}" >> .gitignore`)}`);
    }
    console.error(
      `
Or pass ${accent("--allow-private")} if they genuinely belong in the project.`,
    );
    return 1;
  }
  if (exposed.length) {
    console.log(
      red(
        `\n${exposed.length} file${
          exposed.length === 1 ? " looks like a credential" : "s look like credentials"
        }:`,
      ),
    );
    for (const secret of exposed.slice(0, 20)) console.log(`  ${secret}`);
    if (exposed.length > 20) {
      console.log(dim(`  …and ${exposed.length - 20} more`));
    }
    if (!hasFlag(parsed, "allow-secrets")) {
      console.error(
        `\nNothing was sent. Add them to ${accent(".gitignore")} to leave them` +
          ` behind, or pass ${accent("--allow-secrets")} if they genuinely belong` +
          ` in the project.`,
      );
      return 1;
    }
    console.log(dim("Sending them anyway, because --allow-secrets was given."));
  }

  /*
    Keys pasted into files that are not keys.

    The check above reads names, which finds what a tool wrote and is blind to
    what a person typed. This one reads the files being sent — the case where
    somebody pasted a token into `settings.py` to get something working and it
    stayed there, in a file with an ordinary name that every other check waves
    through.

    Refused separately from `--allow-secrets`, because the answer is different:
    a `.env` should not be sent and the fix is to leave it out, while a source
    file should be sent and the fix is to take the key out of it.
  */
  const pasted = await detectPastedCredentials(
    folder,
    files.map((file) => file.path),
  );
  const stillPasted = pasted.found.filter(
    (finding) => !exposed.includes(finding.path),
  );
  /*
    Said whether anything was found or not.

    The scan stops at twenty thousand files, and it used to stop in silence —
    so a project of forty-seven thousand had twenty-seven thousand of them
    never opened behind a clean run, and the terminal said nothing at all. A
    check that quietly covers half of what it appears to cover is worse than
    one that admits its limit, because the first is believed.
  */
  if (!pasted.reach.complete) {
    console.log(
      dim(
        `Checked the first ${pasted.reach.scanned.toLocaleString()} of ` +
          `${pasted.reach.of.toLocaleString()} files for pasted keys; the ` +
          `rest were not opened.`,
      ),
    );
  }
  if (stillPasted.length) {
    console.log(
      red(
        `
${stillPasted.length} file${
          stillPasted.length === 1 ? " has a credential" : "s have credentials"
        } inside:`,
      ),
    );
    for (const finding of stillPasted.slice(0, 20)) {
      console.log(`  ${finding.path}`);
      for (const one of finding.found.slice(0, 3)) {
        console.log(dim(`    line ${one.line}: ${one.name}`));
      }
      if (finding.found.length > 3) {
        console.log(dim(`    …and ${finding.found.length - 3} more`));
      }
    }
    if (stillPasted.length > 20) {
      console.log(dim(`  …and ${stillPasted.length - 20} more`));
    }
    if (!hasFlag(parsed, "allow-secrets")) {
      console.error(
        `
Nothing was sent. Move the key into an environment variable, and if` +
          ` it has ever been published, replace it at the service that issued` +
          ` it — a key that has leaked stays leaked.` +
          `
Pass ${accent("--allow-secrets")} if these are not real keys.`,
      );
      return 1;
    }
    console.log(dim("Sending them anyway, because --allow-secrets was given."));
  }

  if (added) {
    console.log(
      `${accent("Added an MIT licence")}, so other people may use this.`,
    );
    console.log(
      dim(`  Change it with `) +
        accent("cbx licence <name>") +
        dim(`, or remove it with `) +
        accent("cbx licence none") +
        dim("."),
    );
    console.log("");
  }

  const line = progressLine();
  const uploader = new Uploader(credentials);
  /*
    Built by the shared description, so this and the git remote helper cannot
    drift. They already had: the helper listed deletions in `deletions` alone
    and published versions that still held the deleted file.
  */
  const uploadRequest = uploadRequestFor({
    localPath: folder,
    ...(knownDigests.size ? { knownDigests } : {}),
    changed: files.filter((file) => !file.deleted).map((file) => file.path),
    deleted: files.filter((file) => file.deleted).map((file) => file.path),
    /*
      Nothing is left out, and `changed` above is not the whole of it.

      `submit` sends whatever the rules allow — there is no per-file choosing
      here — but it was passing the listed rows as the selection, and that list
      stops at twenty thousand. A folder of twenty-one thousand files saved
      twenty thousand of them and said "Saved v1" without mentioning the rest.
      An empty exclusion list is how "all of it" is said.
    */
    excluded: [],
    message,
    /*
      A folder's name is the right default and the wrong answer for import,
      where the folder is somewhere temporary and the project should carry
      the name it had at the place it came from. An existing link always
      wins: renaming somebody's project because they passed a flag would be
      a surprise, and the flag exists for projects that do not exist yet.
    */
    projectName:
      link?.slug ?? flagText(parsed, "name") ?? path.basename(folder),
    repositoryId: link?.repositoryId ?? null,
    // Every current CLI publish states its ancestry. A brand-new project is
    // explicitly based on an empty Track; a linked folder names the immutable
    // Version it was last reconciled with.
    baseVersionId: link?.baseVersionId ?? null,
    track: flagText(parsed, "track") ?? (await trackFor(folder)),
    /*
      Only import sets this. Git keeps tracking files committed before the
      rule that excludes them, so a faithful import carries paths the
      project's own ignore rules now refuse; without the override the server
      would reject the publication and the import would be lossy.
    */
    ...(hasFlag(parsed, "allow-ignored") ? { allowIgnored: true } : {}),
    /*
      The same answer, told to the service.

      The check above is the one that asks a person, and it is the better
      place to ask — it is where the files are. But it is also the part an
      old build or a patched one does not run, so the service asks again and
      refuses unless this says the question was put and answered.
    */
    ...(hasFlag(parsed, "allow-secrets") ? { allowSecrets: true } : {}),
    ...(link ? { known: link.local ?? link.manifest ?? {} } : {}),
  });
  /*
    Whether this is walking into a merge, asked before anything is sent.

    The service has offered this since Merge Tracks shipped and nothing ever
    asked, so the first anybody heard that their upload would be diverted was
    after it had finished — which on a slow line is the worst possible moment
    to find out. It is advice: the answer can be stale by the time the
    publish lands and the publish path decides for real, so this says what is
    coming and gets out of the way.
  */
  if (link?.repositoryId && link.baseVersionId) {
    try {
      const ahead = await collisionCheck(
        link.repositoryId,
        link.baseVersionId,
        files.filter((file) => !file.deleted).map((file) => file.path),
      );
      if (ahead.collidingPaths.length) {
        /*
          "1 of your file is" — the plural was on the wrong noun. It is one
          of *your files*, however many of them collided, so only the verb
          changes with the count.
        */
        const many = ahead.collidingPaths.length !== 1;
        console.log(
          accent("Heads up") +
            `  somebody has saved since you last caught up, and ` +
            `${ahead.collidingPaths.length} of your files ` +
            `${many ? "are" : "is"} among what they changed.`,
        );
        for (const path of ahead.collidingPaths.slice(0, 5)) {
          console.log(dim(`  ${path}`));
        }
        if (ahead.collidingPaths.length > 5) {
          console.log(dim(`  and ${ahead.collidingPaths.length - 5} more`));
        }
        console.log(
          dim("  Your upload will be kept whole and put on a merge for you to settle."),
        );
        console.log(dim("  Run cbx get first if you would rather build on theirs."));
        console.log("");
      } else if (ahead.behind) {
        console.log(
          dim(
            "Somebody has saved since you last caught up, but not to any file " +
              "you changed — this will combine on its own.",
          ),
        );
        console.log("");
      }
    } catch {
      /*
        Advice that cannot be fetched is not a reason to refuse a publish.
        The service checks properly at the point it matters.
      */
    }
  }

  let result;
  try {
    const plan = await uploader.plan(
      uploadRequest,
      (progress) => {
        line(
          `  ${track(progress.percent)} ${String(progress.percent).padStart(3)}%  ` +
            `${"plan".padEnd(7)} ${progress.files}/${progress.totalFiles}  ` +
            dim(progress.path.slice(-40)),
        );
      },
    );
    done(line);
    console.log(
      `${accent("Upload plan")}  ${bytes(plan.sourceBytes)} selected → ` +
        `${bytes(plan.compactedBytes)} compacted; ${bytes(plan.chargeableBytes)} new storage.`,
    );
    console.log(
      plan.allowance.exempt
        ? dim("Annual plan: the monthly staged upload allowance does not apply.")
        : dim(
            `Monthly stage ${plan.allowance.stage}: ${plan.allowance.unlockedPercent}% unlocked, ` +
              `${bytes(plan.allowance.remainingBytes)} remains after this reservation.`,
          ),
    );
    if (hasFlag(parsed, "dry-run", "n")) {
      await uploader.cancelPlan(plan, true);
      console.log(
        `${files.length} file${files.length === 1 ? "" : "s"} would be sent or reused:`,
      );
      for (const file of files) console.log(`  ${file.path}`);
      console.log("Nothing was uploaded and no Version was created.");
      return 0;
    }
    result = await uploader.execute(
      uploadRequest,
      plan,
      (progress) => {
        line(
          `  ${track(progress.percent)} ${String(progress.percent).padStart(3)}%  ` +
            `${progress.stage.padEnd(7)} ${progress.files}/${progress.totalFiles}  ` +
            dim(progress.path.slice(-40)),
        );
      },
    );
  } catch (error) {
    done(line);
    /*
      Classified by the shared description rather than by a private regular
      expression, so a push and a submit disagree about nothing — including
      what counts as "the connection failed" and what that means for whether
      the work was saved.
    */
    const failure = classifyPublishFailure(error);
    const text = error instanceof Error ? error.message : String(error);
    if (failure?.kind === "interrupted") {
      console.error(red(`
The connection failed: ${text}`));
      console.error(
        `Your work may already have been saved. Run the same command again —` +
          ` it will not create a second version.`,
      );
      return 1;
    }
    if (failure?.kind === "conflict") {
      /*
        Somebody else saved to this project first. Everything that did not
        overlap has already been combined by the service; what is left is a
        genuine decision, so the answer is to bring their work down and look
        at it rather than to try again harder.
      */
      console.error(
        red(error instanceof Error ? error.message : String(error)),
      );
      console.error(
        `\nRun ${accent("cbx get")} to bring the latest version down, then` +
          ` submit again. Nothing was changed on your account.`,
      );
      return 1;
    }
    throw error;
  }
  done(line);

  if (result.mergeTrack) {
    /*
      The upload is complete and kept, but the project has not changed —
      calling this "saved" would be false, and the base is deliberately left
      alone so the folder still knows what it was working from.
    */
    console.log(
      `\nSomebody else saved first, and ${
        result.mergeTrack.conflicts.length === 1
          ? "one file overlaps"
          : `${result.mergeTrack.conflicts.length} files overlap`
      }.`,
    );
    console.log(
      `Your work is complete and kept as ${accent(result.mergeTrack.reference)}:`,
    );
    for (const conflict of result.mergeTrack.conflicts.slice(0, 20)) {
      console.log(`  ${red(conflict.path)}  ${dim(conflict.kind)}`);
    }
    console.log(
      `\nRun ${accent(`cbx merge ${result.mergeTrack.reference}`)} to decide,` +
        ` or ${accent("cbx merges")} to see everything waiting.`,
    );
    return 0;
  }

  /*
    The version exists on the account. Stopping before the line below is the
    crash that leaves this machine not knowing that — the one the derived
    attempt name exists to make survivable.
  */
  maybeFail("submit:after-commit");

  /*
    What the project is actually called, not what this folder is called.

    A first publish recorded the folder's own name, which is right only when
    nothing renamed the project — and two things routinely do: `--name`, and
    the service turning a display name into a slug. When they differ, every
    command that finds the project through this folder looks up a name that
    does not exist: `tracks`, `versions`, `issues`, `releases`, `people`,
    `watch`, `delete` and the rest all answered "No project matching …" in a
    folder that had just published to it successfully.

    Asked of the service rather than guessed, and only on a first publish,
    because that is the only time this is not already known.
  */
  let recordedSlug = link?.slug;
  if (!recordedSlug) {
    recordedSlug = await projects()
      .then(
        (all) =>
          all.find((candidate) => candidate.id === result.repositoryId)?.slug,
      )
      .catch(() => undefined);
  }

  await writeLink(folder, {
    repositoryId: result.repositoryId,
    slug: recordedSlug ?? uploadRequest.projectName ?? path.basename(folder),
    sequence: result.sequence,
    // What this folder is now working from, so the next submit can say so.
    versionId: result.versionId,
    baseVersionId: result.versionId,
    observedHeadVersionId: result.versionId,
    local: result.local,
    manifest: result.manifest,
    /*
      The line this folder is on survives a save onto it.

      The same fault `get` had and lost: this record is built fresh, and
      without naming `track` every save onto a line moved the folder back to
      main — so the second save on a line went to main, and `cbx propose`
      found the folder "on main" straight after `cbx track spike --new` and a
      save. A one-off `--track` does not move it either: that flag means
      "just this once", so the folder keeps the line it had.
    */
    ...(link?.track ? { track: link.track } : {}),
  });

  /*
    What this save hashed, kept for the next one.

    Merged rather than replaced: `digestsTaken` holds only the files actually
    read this time, and everything served from the existing record has to
    survive or the next save reads it all again — which is precisely the cost
    this exists to avoid.
  */
  await writeDigests(
    result.repositoryId,
    new Map([...knownDigests, ...uploader.digestsTaken()]),
  );
  if (result.repeated) {
    console.log(
      `Already saved as ${accent(`v${result.sequence}`)} by an earlier attempt;` +
        ` nothing was sent again.`,
    );
    return 0;
  }
  console.log(
    `Saved ${accent(`v${result.sequence}`)} · sent ${bytes(result.sentBytes)} in ` +
      `${result.sentFiles} file${result.sentFiles === 1 ? "" : "s"}` +
      /*
        Three different things, kept apart. Sent is what crossed the wire.
        Already on the account is content the service turned out to have, which
        is what makes finishing an interrupted save cheap. Unchanged is what
        the version keeps without either.
      */
      (result.alreadyStoredFiles
        ? `, ${result.alreadyStoredFiles} already on the account`
        : "") +
      (result.reusedFiles ? `, ${result.reusedFiles} unchanged` : "") +
      /*
        "version holds" was the old fused vocabulary. `cbx submit` makes a
        save; a save becomes a version when somebody names it, which is what
        `cbx release` does. Saying "version" here promised something this
        command does not do.
      */
      ` · the save holds ${bytes(result.sourceBytes)}`,
  );
  /*
    Where the time went, when asked for.

    The profiler has existed for a while and nothing ever printed it, so the
    one question it answers — which stage is the save — still had to be
    guessed at. Silent unless CODEROOK_PROFILE is set.
  */
  const profile = profileReport();
  if (profile) console.log(profile);
  return 0;
}

/**
 * Work out what an upgraded folder actually holds, or admit that it cannot.
 *
 * Returns the materialisation when the folder matches its recorded version
 * exactly — which proves the manifest describes what is here — and null when
 * anything differs, because a difference is either somebody's unsaved edit or
 * a copy their merge left stale, and nothing on disk says which.
 */
async function establishMaterialisation(
  folder: string,
  link: Link,
): Promise<Record<string, string> | null> {
  const rules = await readRules(folder);
  const against = new Map(Object.entries(link.manifest));
  const differing = await changedFiles(folder, rules, against);
  return differing.length ? null : { ...link.manifest };
}

async function commandGet(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  const { link } = await reconcile(folder);
  if (!link) {
    console.error(red("This folder is not linked to a project on your account."));
    return 1;
  }

  /*
    Fetching writes over what is here. That is the point of it — but a file
    somebody has edited and not yet saved is not the same as a file sitting
    where the last fetch left it, and overwriting the first loses work that
    exists nowhere else.

    Telling them apart needs the materialisation record: disk differing from
    what was placed here is an edit, and disk matching it is simply an old
    copy. Only the edits are worth stopping for, and only when the incoming
    version would actually change those files.
  */
  /*
    A fetch that did not finish leaves the folder part-way to a version, with
    the record still describing what was there before. Every difference it
    shows is this operation's own work, not somebody's edit, so finishing the
    job is the only sensible reading — and refusing would strand the folder in
    the one state that ought to be easiest to leave.

    It could only have started if there was nothing conflicting here, so
    completing it cannot bury anybody's changes.
  */
  const resuming = Boolean(link.fetching);
  if (resuming) {
    console.log(
      dim(`A fetch of v${link.fetching!.sequence} did not finish; completing it.`),
    );
  }

  const replacing = hasFlag(parsed, "replace", "f", "force");

  /*
    A folder connected by a client older than the materialisation record has
    only the Version manifest, which says what the project held — not what
    was placed here. The two are the same only until somebody's merge makes
    them differ, so assuming it would be the very guess that lost work in the
    first place.

    It can be established rather than assumed: if the folder matches its own
    recorded version exactly, then it demonstrably holds that version and the
    manifest is the materialisation. If it does not match, an edit cannot be
    told from a stale copy, and fetching is refused until somebody says which
    it is.
  */
  if (!link.local) {
    const settled = await establishMaterialisation(folder, link);
    if (settled) {
      link.local = settled;
      await writeLink(folder, link);
    } else if (!replacing) {
      console.error(
        red("This folder was connected by an older version of CodeRook,"),
      );
      console.error(
        "which did not record what it had received, so changed files here",
      );
      console.error("cannot be told apart from copies left behind by a merge.\n");
      console.error(
        `Save them with ${accent("cbx submit")} if they are your work, or ` +
          `take the\nsaved version exactly with ${accent("cbx get --replace")}.`,
      );
      return 1;
    }
  }

  if (link.local && !replacing) {
    const rules = await readRules(folder);
    const edited = await changedFiles(folder, rules, new Map(Object.entries(link.local)));
    if (edited.length) {
      const downloader = new Downloader(credentials);
      const latest = (await downloader.versions(link.repositoryId))[0];
      const incoming = new Map(
        latest
          ? (await downloader.files(link.repositoryId, latest.id)).map((file) => [
              file.path,
              file.sha256,
            ])
          : [],
      );
      /*
        Resuming needs a different question. Half these files differ from the
        record because the interrupted run already replaced them, and those
        are finished work rather than anybody's edit. What matters is a file
        that matches neither what was here nor what is arriving — that one was
        changed by hand while the fetch was stopped, and completing over it
        would bury the only copy.
      */
      if (resuming) {
        const notYetArrived = await changedFiles(folder, rules, incoming);
        const changedInTheGap = notYetArrived.filter(
          (file) =>
            !file.deleted &&
            incoming.has(file.path) &&
            edited.some((one) => one.path === file.path),
        );
        if (!changedInTheGap.length) {
          return fetchInto(
            link.repositoryId, folder, link.slug, link.local ?? null, "replace",
            await trackFor(folder),
          );
        }
        console.error(
          red(`${changedInTheGap.length} file${changedInTheGap.length === 1 ? "" : "s"} ` +
            `changed while the interrupted fetch was stopped:`),
        );
        for (const file of changedInTheGap.slice(0, 20)) console.error(`  ${file.path}`);
        console.error(
          `
Save them with ${accent("cbx submit")}, or finish the fetch and ` +
            `discard them with ${accent("cbx get --replace")}.`,
        );
        return 1;
      }
      /*
        Only a genuine collision stops the fetch: this folder changed the
        file and so did the incoming version. An edit to a file the version
        left alone is simply kept — fetching has nothing to say about it —
        and stopping for those would make the warning something people learn
        to click past.
      */
      const atRisk = edited.filter(
        (file) =>
          !file.deleted &&
          incoming.has(file.path) &&
          incoming.get(file.path) !== link.local![file.path],
      );
      if (atRisk.length) {
        console.error(
          red(
            `${atRisk.length} file${atRisk.length === 1 ? "" : "s"} here ` +
              `${atRisk.length === 1 ? "has" : "have"} changes that fetching would overwrite:`,
          ),
        );
        for (const file of atRisk.slice(0, 20)) console.error(`  ${file.path}`);
        if (atRisk.length > 20) console.error(dim(`  …and ${atRisk.length - 20} more`));
        console.error(
          `\nSave them first with ${accent("cbx submit")}, or discard them ` +
            `with ${accent("cbx get --replace")}.`,
        );
        return 1;
      }
    }
  }

  /*
    Only what this folder received may be removed by catching up, and only
    what the version actually changed is written over — unless somebody asks
    for an exact copy, which is how a damaged folder is repaired.
  */
  return fetchInto(
    link.repositoryId,
    folder,
    link.slug,
    link.local ?? null,
    replacing ? "replace" : "reconcile",
    // The line this folder saves to, so catching up brings that line down.
    await trackFor(folder),
  );
}

async function commandClone(parsed: Parsed): Promise<number> {
  const reference = parsed.positional[0];
  if (!reference) {
    console.error(red("Which project? Try: cbx clone <project>"));
    return 1;
  }
  const project = await findProject(reference);
  if (!project) {
    console.error(
      red(
        `No project named ${reference}.` +
          (reference.includes("/")
            ? " Check the owner and the name, and that it is public."
            : " It is not on your account — for somebody else's, name them" +
              " too: cbx clone <owner>/<project>."),
      ),
    );
    return 1;
  }
  if (!project.versionCount) {
    console.error(red(`${project.slug} has no saved version to fetch.`));
    return 1;
  }
  const destination = path.resolve(parsed.positional[1] ?? project.slug);
  /*
    A clone opens on the project's default line, or on the one named.

    It used to take whichever version was newest across every line, which is
    only the same thing while a project has one. As soon as somebody pushed to
    a branch, that branch held the newest version — so cloning the project
    handed you their unfinished work under the impression it was the project.
    Nothing said so: the fetch reported a version number and the files looked
    like a project, just not the one anybody asked for.

    Naming a line here also removes the clone-switch-fetch dance that was the
    only way to get a branch before, which is what exposed the same fault in
    `get`.
  */
  const wanted = flagText(parsed, "track") ?? project.defaultBranch;
  /*
    Falling back rather than failing when the default line does not exist.
    `defaultBranch` is a property of the project and a line can be renamed out
    from under it; refusing to clone at all in that case would be a worse
    answer than the old behaviour. An explicitly named line is still refused,
    because there the person said which one they meant.
  */
  const lines = await new Tracks(credentials).list(project.id);
  const usable = lines.some(
    (line) => line.kind === "line" && line.name === wanted && line.headVersionId,
  );
  if (!usable && !flagText(parsed, "track")) {
    console.log(
      dim(`This project has no line called ${wanted}; taking its newest version.`),
    );
  }
  return fetchInto(
    project.id,
    destination,
    project.slug,
    null,
    "replace",
    usable || flagText(parsed, "track") ? wanted : undefined,
  );
}

async function fetchInto(
  repositoryId: string,
  destination: string,
  slug: string,
  /*
    What this folder received before, so a file the project has since dropped
    is removed. Absent — a clone, or a folder whose record was lost — nothing
    is removed, because "missing from the version" cannot then be told from
    "never came from the version at all".
  */
  held?: Record<string, string> | null,
  mode: "reconcile" | "replace" = "replace",
  /*
    The line to fetch. Omitted means the project's newest version, which is
    right for a clone and wrong for a folder that has chosen a line.
  */
  trackName?: string,
): Promise<number> {
  const downloader = new Downloader(credentials);
  const all = await downloader.versions(repositoryId);

  /*
    The head of this folder's line, not the newest version in the project.

    Those are the same thing only while a project has one line. With two, the
    newest version usually belongs to the *other* one — so switching to a line
    and fetching brought down the line you had just left, reported success,
    and left the folder holding the wrong contents while still claiming to
    save to the line you asked for. The next publish would then be computed
    against a baseline from somewhere else.

    Worse than a wrong answer: `track` ends by telling you to run `get`, so
    the command that set this up was the one recommending it.
  */
  let latest = all[0];
  if (trackName) {
    const chosen = (await new Tracks(credentials).list(repositoryId)).find(
      (candidate) => candidate.name === trackName && candidate.kind === "line",
    );
    if (!chosen) {
      console.error(red(`This project has no line called ${trackName}.`));
      return 1;
    }
    if (!chosen.headVersionId) {
      console.error(red(`The line ${trackName} has nothing saved to it yet.`));
      return 1;
    }
    const head = all.find((version) => version.id === chosen.headVersionId);
    if (!head) {
      console.error(red(`Could not read the current version of ${trackName}.`));
      return 1;
    }
    latest = head;
  }
  if (!latest) {
    console.error(red("That project has no saved version."));
    return 1;
  }
  /*
    Recorded before the folder is touched. If this run does not reach the
    end, the next one finds this and knows the differences it sees are its
    own unfinished work rather than somebody's edits.
  */
  const before = await readLink(destination);
  if (before) {
    await writeLink(destination, {
      ...before,
      fetching: { versionId: latest.id, sequence: latest.sequence },
    });
  }

  const line = progressLine();
  const result = await downloader.run(
    repositoryId,
    latest.id,
    destination,
    (progress) => {
      line(
        `  ${track(progress.percent)} ${String(progress.percent).padStart(3)}%  ` +
          `${progress.files}/${progress.totalFiles}  ` +
          dim(progress.path.slice(-40)),
      );
    },
    // What this folder received last time, so a file the project has since
    // dropped is removed while everything untracked is left alone.
    held,
    mode,
  );
  done(line);
  // Fetching is how a folder catches up, so this is what moves its base.
  await writeLink(destination, {
    repositoryId,
    slug,
    sequence: latest.sequence,
    versionId: latest.id,
    baseVersionId: latest.id,
    observedHeadVersionId: latest.id,
    // Fetching writes every file, so the folder now holds what the
    // version holds and the two agree again.
    local: result.manifest,
    manifest: result.manifest,
    /*
      The line this folder is on survives being caught up.

      This record is built fresh rather than merged, so anything not named
      here is dropped — and `track` was not named. Fetching therefore moved
      the folder back to `main` every time, silently: the files were right,
      the folder reported the wrong line, and the next publish went somewhere
      nobody chose.
    */
    ...(trackName ? { track: trackName } : {}),
    // Reached the end, so there is no longer a fetch in flight.
  });
  // The record is written; the run has not reported success yet.
  maybeFail("get:after-record");
  console.log(
    `${accent(`v${latest.sequence}`)} · ${result.files} files · ${bytes(result.bytes)} into ${destination}`,
  );
  return 0;
}

/**
 * What this folder is carrying that probably is not the work.
 *
 * The desktop offers these when a folder is added — a virtual environment, a
 * node_modules, a build directory — and the command line never did, so a
 * project set up from a terminal sent its dependencies to the service and
 * paid for the storage. The detector is the desktop's own rather than a
 * second opinion written here, because two rules about what counts as
 * generated output is two answers to the same question.
 *
 * Nothing is written without being asked for. Listing is the default: a tool
 * that silently edits your .gitignore is one you have to check up on.
 */
async function suggestRules(folder: string, apply: boolean): Promise<number> {
  const rules = await readRules(folder);
  /*
    Sizes for the whole folder, not for the listed rows.

    This used to measure `changedFiles`, which stops at twenty thousand — so
    on the projects with the most to leave out, the sizes here were a fraction
    of the truth and the biggest item could be missing from the list outright.
    The scan carries a size for every file it walks past now, capped or not.
  */
  const listing = { listed: 0, total: 0, sizes: [] as Array<{ path: string; size: number }> };
  await changedFiles(folder, rules, null, "add-and-update", undefined, listing);
  const suggestions = suggestExclusions(listing.sizes);

  if (!suggestions.length) {
    console.log(dim("Nothing here looks like it should be left out."));
    return 0;
  }

  for (const one of suggestions) {
    const mark = one.recommended ? green("+") : dim("?");
    console.log(
      `${mark} ${one.pattern.padEnd(26)} ${dim(
        `${bytes(one.bytes)} · ${one.files} file${one.files === 1 ? "" : "s"} · ${one.reason}`,
      )}`,
    );
  }

  /*
    Only the confident ones are written. Generated output and dependency
    directories are safe to assume; anything that might be the work itself is
    marked with a question and left for a person, because the cost of guessing
    wrong is somebody's project not being backed up.
  */
  const recommended = suggestions.filter((one) => one.recommended);
  if (!apply) {
    console.log("");
    console.log(dim("Add the + ones with ") + accent("cbx ignore --suggest --apply"));
    return 0;
  }
  if (!recommended.length) {
    console.log("");
    console.log(dim("None of these are safe to assume — add them by hand."));
    return 0;
  }

  const addition = rulesFromSuggestions(recommended);
  const shared = rules.shared.trimEnd();
  await writeRules(folder, {
    shared: shared ? `${shared}

${addition}` : addition,
    local: rules.local,
  });
  console.log("");
  console.log(
    green(`Added ${recommended.length} rule${recommended.length === 1 ? "" : "s"} to `) +
      path.join(folder, ".gitignore"),
  );
  return 0;
}

async function commandRules(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  if (hasFlag(parsed, "suggest")) {
    return suggestRules(folder, hasFlag(parsed, "apply"));
  }
  if (hasFlag(parsed, "init")) {
    /*
      Whatever `readRules` decided, which is now the template that matches the
      folder rather than one generic list. Writing STARTER_IGNORE here would
      have handed a Unity project the JavaScript rules, which is how an upload
      came back missing things inside Assets.
    */
    const existing = await readRules(folder);
    await writeRules(folder, existing);
    console.log(`Wrote ${path.join(folder, ".gitignore")}`);
    return 0;
  }
  const rules = await readRules(folder);
  process.stdout.write(rules.shared);
  if (rules.local.trim()) {
    console.log(dim("\n# --- only on this machine (.git/info/exclude) ---"));
    process.stdout.write(rules.local);
  }
  return 0;
}

async function commandBundle(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed, 0);
  const target = path.resolve(
    parsed.positional[1] ?? `${path.basename(folder)}.cbx`,
  );
  const rules = await readRules(folder);
  const entries = (await changedFiles(folder, rules, null)).map((file) => file.path);
  const line = progressLine();
  const result = await packBundle(
    { root: folder, target, entries, sourceName: path.basename(folder) },
    (progress) => {
      line(
        `  ${track(progress.percent)} ${String(progress.percent).padStart(3)}%  ` +
          dim(progress.path.slice(-40)),
      );
    },
  );
  done(line);
  const saved = Math.max(
    0,
    100 - Math.ceil((result.archiveBytes / Math.max(result.sourceBytes, 1)) * 100),
  );
  console.log(
    `${target} · ${bytes(result.archiveBytes)} from ${bytes(result.sourceBytes)} ` +
      `(${saved}% smaller) · ${result.uniqueChunks} chunks`,
  );
  return 0;
}

async function commandUnbundle(parsed: Parsed): Promise<number> {
  const source = parsed.positional[0];
  if (!source) {
    console.error(red("Which bundle? Try: cbx unbundle <file.cbx> [folder]"));
    return 1;
  }
  const manifest = await readBundleManifest(path.resolve(source));
  /*
    The bundle's own name, never its path. `source_name` comes from the file
    being opened, and taken whole it could be `/home/you/.ssh` or `C:\Users` —
    and the folder it names is deleted and replaced. Only the last name
    survives, into the current folder, and only if it is a plain name.
  */
  const suggested = path.posix.basename((manifest.source_name ?? "").replace(/\\/g, "/"));
  const plainName =
    suggested && !whyUnsafe(suggested) && !/^[.]+$/.test(suggested) && !/[:]/.test(suggested);
  if (!parsed.positional[1] && !plainName) {
    console.error(red("That bundle does not name a usable folder. Try: cbx unbundle <file.cbx> <folder>"));
    return 1;
  }
  const destination = path.resolve(parsed.positional[1] ?? suggested);
  const line = progressLine();
  const result = await unpackBundle(path.resolve(source), destination, (progress) => {
    line(
      `  ${track(progress.percent)} ${String(progress.percent).padStart(3)}%  ` +
        dim(progress.path.slice(-40)),
    );
  });
  done(line);
  console.log(`${result.files} files · ${bytes(result.bytes)} into ${destination}`);
  return 0;
}

async function commandInspect(parsed: Parsed): Promise<number> {
  const source = parsed.positional[0];
  if (!source) {
    console.error(red("Which bundle? Try: cbx inspect <file.cbx>"));
    return 1;
  }
  const manifest = await readBundleManifest(path.resolve(source));
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  console.log(
    `${bold(manifest.source_name)} · format ${manifest.format} v${manifest.format_version}`,
  );
  console.log(
    `${manifest.files.length} files · ${bytes(total)} · ` +
      `${Object.keys(manifest.chunks).length} chunks`,
  );
  if (hasFlag(parsed, "files")) {
    for (const file of manifest.files) {
      console.log(`  ${bytes(file.size).padStart(9)}  ${file.path}`);
    }
  }
  return 0;
}

async function commandDoctor(): Promise<number> {
  const service = await health().catch(() => null);
  console.log(`cbx ${VERSION} · Node ${process.versions.node} · ${process.platform}`);
  console.log(`Config: ${configDirectory()}`);
  console.log(
    service
      ? `Service: ${service.status} · schema ${service.schemaVersion}` +
          (service.contentEncodings ? ` · accepts ${service.contentEncodings.join(", ")}` : "")
      : red("Service: unreachable"),
  );
  const token = await loadToken();
  if (!token) {
    console.log("Account: not signed in");
    return 0;
  }
  try {
    const account = await whoami();
    console.log(`Account: ${account.email} · ${account.plan}`);
  } catch (error) {
    console.log(red(`Account: ${error instanceof Error ? error.message : error}`));
  }
  return 0;
}




/**
 * Everything waiting on a decision, for one folder's project.
 *
 * A diverted upload is easy to forget about — it is not an error and the
 * project looks untouched — so this is the way to find out that work of
 * yours is sitting somewhere, still complete, waiting.
 */
/**
 * Offer this folder's line of work to another line, usually main.
 *
 * The folder's line is the one proposed, because it is the one being worked
 * on; proposing main is refused rather than guessed at, since the answer to
 * "propose what?" is then a line nobody named.
 */
async function commandPropose(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  const link = await readLink(folder);
  if (!link) {
    console.error(red("This folder is not linked to a project on your account."));
    return 1;
  }
  const from = flagText(parsed, "from") ?? (await trackFor(folder));
  const into = flagText(parsed, "into") ?? "main";
  if (from === into) {
    console.error(
      red(`This folder is on ${from}. Start a line with cbx track <name> --new, save onto it, then propose it.`),
    );
    return 1;
  }
  const title = flagText(parsed, "message", "m", "title");
  if (!title) {
    console.error(red('Give it a title: cbx propose -m "What this changes"'));
    return 1;
  }
  const opened = await openProposal(link.repositoryId, {
    from,
    into,
    title,
    ...(flagText(parsed, "body") ? { body: flagText(parsed, "body")! } : {}),
  });
  const reference = opened.mergeTrack.reference;
  console.log(`${accent(reference)}  ${from} → ${into}  ${title}`);
  if (opened.conflicts.settled) {
    console.log(dim(`  ${opened.conflicts.settled} file(s) both sides changed were combined line by line.`));
  }
  console.log(
    opened.conflicts.unresolved
      ? `  ${opened.conflicts.unresolved} file(s) need a decision. Run cbx merge ${reference} to look.`
      : dim(`  Nothing to decide. Run cbx merge ${reference} --apply when it has been reviewed.`),
  );
  return 0;
}

async function commandProposals(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  const link = await readLink(folder);
  if (!link) {
    console.error(red("This folder is not linked to a project on your account."));
    return 1;
  }
  const listed = await proposals(link.repositoryId, hasFlag(parsed, "all"));
  if (!listed.length) {
    console.log(hasFlag(parsed, "all") ? "No proposals yet." : "No open proposals.");
    return 0;
  }
  for (const proposal of listed) {
    const counts = proposal.conflicts;
    const waiting = counts && counts.unresolved ? red(`${counts.unresolved} to decide`) : "";
    console.log(
      `${accent(proposal.reference)}  ${proposal.proposal?.from ?? "?"} → ${proposal.proposal?.into ?? "?"}  ` +
        `${proposal.proposal?.title ?? ""}  ${waiting}` +
        (proposal.state === "open" ? "" : dim(`  ${proposal.state}`)),
    );
  }
  console.log(dim("\nRun cbx merge <reference> to look at one."));
  return 0;
}

async function commandMerges(parsed: Parsed): Promise<number> {
  const folder = folderFor(parsed);
  const link = await readLink(folder);
  if (!link) {
    console.error(red("This folder is not linked to a project on your account."));
    return 1;
  }
  const waiting = (await mergeTracks(link.repositoryId)).filter(
    (merge) => merge.state === "open",
  );
  if (!waiting.length) {
    console.log("Nothing is waiting to be merged.");
    return 0;
  }
  for (const merge of waiting) {
    const counts = merge.conflicts;
    console.log(
      `${accent(merge.reference)}  ${
        counts ? `${counts.unresolved} of ${counts.total} still to decide` : ""
      }  ${dim(new Date(merge.createdAt).toLocaleString())}`,
    );
  }
  console.log(dim(`
Run cbx merge <reference> to look at one.`));
  return 0;
}

/** Find a merge by the reference a person would type, such as M-2. */
async function findMerge(folder: string, reference: string) {
  const link = await readLink(folder);
  if (!link) throw new Error("This folder is not linked to a project on your account.");
  const all = await mergeTracks(link.repositoryId);
  const found = all.find(
    (merge) => merge.reference.toLowerCase() === reference.toLowerCase(),
  );
  if (!found) throw new Error(`No merge called ${reference} on this project.`);
  return found;
}

/**
 * Look at one merge, and optionally finish it.
 *
 * Deciding happens here rather than in a command of its own because the
 * decision only means anything next to the thing it is about.
 */
async function commandMerge(parsed: Parsed): Promise<number> {
  const reference = parsed.positional[0];
  if (!reference) {
    console.error(red("Which merge? Try: cbx merge M-1"));
    return 1;
  }
  const folder = folderFor({ ...parsed, positional: parsed.positional.slice(1) });
  const summary = await findMerge(folder, reference);
  const detail = await mergeTrack(summary.id);

  /*
    Asking people to look. Named the way people name each other, and said
    back by name, so a typo in a username is visible rather than silent.
  */
  const ask = flagText(parsed, "ask");
  if (ask) {
    const asked = await requestReviews(
      summary.id,
      ask.split(",").map((name) => name.trim()).filter(Boolean),
    );
    console.log(
      asked.length
        ? `Asked ${asked.map((person) => person.displayName).join(", ")} to review ${summary.reference}.`
        : "Nobody new was asked.",
    );
  }

  if (hasFlag(parsed, "cancel")) {
    await cancelMerge(summary.id);
    console.log(
      `${summary.reference} cancelled. Your upload is still stored and nothing published was touched.`,
    );
    return 0;
  }

  const outstanding = detail.conflicts.filter((conflict) => !conflict.resolvedAt);
  const decision = hasFlag(parsed, "mine")
    ? "take_candidate"
    : hasFlag(parsed, "theirs")
      ? "take_target"
      : hasFlag(parsed, "drop")
        ? "delete"
        : hasFlag(parsed, "both", "keep-both")
          ? "keep_both"
          : null;

  if (decision) {
    const only = flagText(parsed, "path");
    const chosen = only
      ? outstanding.filter((conflict) => conflict.path === only)
      : outstanding;
    if (!chosen.length) {
      console.error(red(only ? `${only} has no outstanding decision.` : "Nothing left to decide."));
      return 1;
    }
    for (const conflict of chosen) {
      await resolveMergeConflict(summary.id, conflict.id, decision);
      console.log(
        `  ${conflict.path} → ${
          decision === "take_candidate"
            ? "yours"
            : decision === "take_target"
              ? "theirs"
              : decision === "keep_both"
                ? `both, yours saved beside it`
                : "removed"
        }`,
      );
    }
  }

  const now = await mergeTrack(summary.id);
  if (now.proposal) {
    console.log(
      `\n${accent(now.mergeTrack.reference)}  ${now.proposal.from} → ${now.proposal.into}` +
        (now.changeRequest ? `  ${now.changeRequest.title}` : ""),
    );
    const approvals = now.changeRequest?.approvals;
    if (approvals && approvals.required) {
      console.log(
        `  ${approvals.satisfied ? accent("approved") : red("waiting for review")}` +
          dim(` · ${approvals.approvals} of ${approvals.required} approvals`),
      );
    }
    for (const blocked of now.provisional.blockedByChecks ?? []) {
      console.log(`  ${red("check")}  ${blocked}`);
    }
    for (const one of now.changeRequest?.reviews ?? []) {
      if (one.verdict === "comment" && !one.body) continue;
      const said =
        one.verdict === "approve"
          ? accent("approved")
          : one.verdict === "request_changes"
            ? red("asked for changes")
            : dim("commented");
      console.log(`  ${one.reviewerName ?? "A reviewer"} ${said}${one.body ? dim(`: ${one.body}`) : ""}`);
    }
    const waiting = (now.changeRequest?.requested ?? []).filter((person) => !person.reviewed);
    if (waiting.length) {
      console.log(dim(`  waiting on ${waiting.map((person) => person.displayName).join(", ")}`));
    }
  }
  console.log(
    `
${accent(now.mergeTrack.reference)} · ${now.provisional.fileCount} files · ` +
      (now.provisional.ready
        ? "ready to apply"
        : `${now.provisional.unresolvedPaths.length} still to decide`),
  );
  for (const conflict of now.conflicts) {
    console.log(
      `  ${conflict.resolvedAt ? accent("decided") : red("waiting")}  ${conflict.path}` +
        `  ${dim(conflict.kind)}${conflict.resolution ? dim(` (${conflict.resolution})`) : ""}`,
    );
  }

  if (hasFlag(parsed, "apply")) {
    if (!now.provisional.ready) {
      console.error(red("\nStill undecided files; nothing was applied."));
      return 1;
    }
    const applied = await applyMerge(summary.id);
    console.log(`
Applied as ${accent(`v${applied.version.sequence}`)}.`);
    if (applied.closedIssues?.length) {
      console.log(`Closed ${applied.closedIssues.map((number) => `#${number}`).join(", ")}.`);
    }
    console.log(dim("Run cbx get to bring it down to this folder."));
    return 0;
  }

  const stillOpen = now.conflicts.some((conflict) => !conflict.resolvedAt);
  if (!decision && stillOpen) {
    console.log(
      dim(
        `
--mine keeps yours, --theirs keeps what was already saved,` +
          ` --drop removes the file.
Add --path <file> for one file, then --apply when ready.`,
      ),
    );
  } else if (now.provisional.ready) {
    console.log(dim(`
Run cbx merge ${now.mergeTrack.reference} --apply to publish it.`));
  }
  return 0;
}


/**
 * Do this project's work on this machine.
 *
 * The other half of Actions. CodeRook writes down that a run is wanted; this
 * asks whether there is one, fetches the version into a throwaway folder,
 * runs the workflow's command there, sends the output up as it goes, and
 * reports the verdict.
 *
 * The trust boundary is said out loud rather than buried in documentation,
 * because it is the thing somebody should decide on purpose: anybody who can
 * set a workflow's command on this project can run that command on this
 * machine, as whoever started this.
 */
async function commandRunner(parsed: Parsed): Promise<number> {
  const reference = parsed.positional[0] ?? flagText(parsed, "project", "p");
  if (!reference) {
    console.error(red("Which project? cbx runner <project>"));
    return 1;
  }
  const project = await findProject(reference);
  if (!project) {
    console.error(red(`No project of yours matches "${reference}".`));
    return 1;
  }

  const name = flagText(parsed, "name") ?? os.hostname();
  /*
    What this machine will answer to. Its own platform unless told otherwise,
    because that is what somebody means when they write a workflow that has to
    produce a Windows installer.
  */
  const labels = (flagText(parsed, "labels", "label") ?? "")
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean);
  const answersTo = labels.length ? labels : defaultLabels();
  const once = hasFlag(parsed, "once");
  const every = Math.min(
    Math.max(Number(flagText(parsed, "poll") ?? 5), 1),
    300,
  );

  console.log(`${bold("CodeRook runner")} ${dim(`· ${name}`)}`);
  console.log(
    `Taking work for ${accent(project.slug)} ` +
      dim(`· answering to ${answersTo.join(", ")}`),
  );
  /*
    Printed every time rather than once on first use. Somebody who left this
    running in a terminal a fortnight ago should be able to look at it and
    see what it is permitted to do, without going to find the manual.
  */
  console.log(
    dim(
      "Anyone who can set a workflow's command on this project can run it " +
        "here, as you.",
    ),
  );
  /*
    Said separately because it is the part people get wrong. The account token
    is kept out of the command's environment, but a command runs as this user
    and this user can read the token file — so the honest advice is a token
    made for the runner, which can be revoked without taking the desktop
    application and the command line down with it.
  */
  console.log(
    dim(
      `A command here runs as you and can read ${configDirectory()}. ` +
        "Use a token minted for this machine, not your everyday one.",
    ),
  );
  console.log(dim("Stop with Ctrl-C."));
  if (once) console.log(dim("Taking one job, then stopping."));
  console.log("");

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("");
    console.log(dim("Finishing the current job, then stopping."));
  });

  for (;;) {
    let job = null;
    try {
      job = await claim(project.id, name, VERSION, answersTo);
    } catch (error) {
      /*
        Kept going rather than exiting. A runner is meant to be left alone,
        and the network being briefly unavailable is not a reason to need
        somebody to come back and start it again.
      */
      console.error(red(error instanceof Error ? error.message : String(error)));
      if (once) return 1;
      await new Promise((wake) => setTimeout(wake, every * 1000));
      continue;
    }

    if (!job) {
      if (once || stopping) {
        if (once) console.log(dim("Nothing waiting."));
        return 0;
      }
      await new Promise((wake) => setTimeout(wake, every * 1000));
      continue;
    }

    const label = `#${job.number} ${job.workflowName}`;
    console.log(`${accent("▶")} ${label}${job.attempts > 1 ? dim(` (attempt ${job.attempts})`) : ""}`);
    const began = Date.now();
    const verdict = await performRun(project.id, job, name);
    try {
      await report(project.id, job.runId, verdict, Date.now() - began);
    } catch (error) {
      console.error(
        red(
          `Could not report ${label}: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
    }
    console.log(
      verdict.status === "passed"
        ? `${green("✓")} ${label} — ${verdict.summary}`
        : `${red("×")} ${label} — ${verdict.summary}`,
    );

    if (once || stopping) return verdict.status === "passed" ? 0 : 1;
  }
}

/*
  The commands, described where they are defined.

  This replaced a plain name-to-function map sitting beside a hand-written
  usage string. The two drifted, as they always do — the help is now generated
  from these rows, so a command that exists is documented and a command that is
  documented exists.
*/
const SPECS: CommandSpec[] = [
  {
    name: "sign-in",
    aliases: ["login"],
    group: "Getting started",
    summary: "store a personal access token on this machine",
    usage: "sign-in",
    detail:
      "Asks for a personal access token and saves it. Create one in your\n" +
      "account settings on the website. The token is stored in your user\n" +
      "configuration, not in the project folder, so it never lands in a\n" +
      "version by accident.",
    options: [
      { flags: "--token <value>", description: "supply it instead of being asked" },
    ],
    run: commandSignIn,
  },
  {
    name: "whoami",
    group: "Getting started",
    summary: "who this machine is signed in as",
    usage: "whoami",
    run: () => commandWhoami(),
  },
  {
    name: "sign-out",
    aliases: ["logout"],
    group: "Getting started",
    summary: "forget the token on this machine",
    usage: "sign-out",
    run: commandSignOut,
  },
  {
    name: "status",
    group: "Working with a folder",
    summary: "what is here that is not saved yet",
    usage: "status [folder]",
    detail:
      "Compares the folder against the last version you sent and lists what\n" +
      "changed. Says nothing about other people's work — use `merges` for that.\n\n" +
      "In a folder with a history of its own (see `cbx init`), compares\n" +
      "against the last local save instead.",
    run: localFirst(localStatus, commandStatus, (parsed) => folderFor(parsed)),
  },
  {
    name: "submit",
    aliases: ["publish"],
    group: "Working with a folder",
    summary: "send the changes as a new save",
    usage: 'submit [folder] -m "…"',
    detail:
      "Sends everything that changed since the last save. If the folder is\n" +
      "not linked to a project yet, one is created on your account, named\n" +
      "after the folder and private to begin with.\n\n" +
      "A save is not a version. Nobody outside the project can see one until\n" +
      "it is named, which is what `cbx release` does — so submitting is as\n" +
      "cheap and as private as you want it to be.",
    options: [
      { flags: "-m, --message <text>", description: "what changed, in a sentence" },
      { flags: "-n, --dry-run", description: "show what would be sent, send nothing" },
      {
        flags: "--name <name>",
        description: "name a new project this, instead of after the folder",
      },
      {
        flags: "--allow-secrets",
        description: "send files that look like credentials, and files with keys inside",
      },
      {
        flags: "--sync",
        description:
          "treat a file that is no longer here as deleted, rather than keeping the saved copy",
      },
      {
        flags: "--track <name>",
        description: "save onto this line, just this once",
      },
      {
        flags: "--no-licence",
        description:
          "do not add a licence to a new project; nobody may reuse it",
      },
    ],
    examples: [
      'cbx submit -m "Fix the export dialog"',
      'cbx submit --track spike -m "Try the other encoder"',
    ],
    run: commandSubmit,
  },
  {
    name: "diff",
    aliases: ["changes"],
    group: "Working with a folder",
    summary: "what changed, line by line",
    usage: "diff [from] [to]",
    detail:
      "With nothing after it, compares this folder against the version it is\n" +
      "on. With one version, compares this folder against that one. With two,\n" +
      "compares two saved versions — which the service answers from its own\n" +
      "stored trees, so an untouched corner of a large project costs nothing.\n\n" +
      "A version can be given as a number, as v12, or by the name it was\n" +
      "released under.\n\n" +
      "In a folder with a history of its own (see `cbx init`), the same\n" +
      "positions name local saves: a line, a line~N, or the start of an id.",
    options: [
      { flags: "--name-only", description: "list the files and not their lines" },
      { flags: "--path <text>", description: "only paths containing this" },
      {
        flags: "--context <n>",
        description: "lines of context around a change (default 3)",
      },
      { flags: "--project <name>", description: "which project" },
    ],
    examples: ["cbx diff", "cbx diff 12", "cbx diff 11 12 --name-only", "cbx diff main~1 main"],
    run: localFirst(localDiff, commandDiff),
  },
  {
    name: "init",
    group: "History on this machine",
    summary: "start a history in this folder, kept on this machine",
    usage: "init [folder]",
    detail:
      "Makes a .cbx/ folder holding the project's history, so you can save,\n" +
      "compare and go back with no connection at all. Nothing in it is sent\n" +
      "anywhere by itself.\n\n" +
      "Once a folder has one, `status`, `diff`, `log` and `switch` answer from\n" +
      "it. `submit` still sends the folder to CodeRook as it always has.",
    options: [{ flags: "--line <name>", description: "what to call the first line (default main)" }],
    examples: ["cbx init", "cbx init my-game --line dev"],
    run: commandInit,
  },
  {
    name: "save",
    group: "History on this machine",
    summary: "record the folder as it is now, on this machine",
    usage: 'save -m "…"',
    detail:
      "Records every file the ignore rules let through, on the line the\n" +
      "folder is on. Only files that changed are read again, and a large file\n" +
      "is split so an edit stores the pieces around it rather than all of it.\n\n" +
      "A save identical to the last one is not made.",
    options: [
      { flags: "-m, --message <text>", description: "what changed" },
      { flags: "--author <name>", description: "who to record, instead of the configured name" },
      { flags: "-f, --force", description: "finish a merge even though conflict markers remain" },
    ],
    examples: ['cbx save -m "Tune the jump height"'],
    run: commandSave,
  },
  {
    name: "log",
    group: "History on this machine",
    summary: "the saves on this line, newest first",
    usage: "log [from]",
    detail:
      "In a folder with a history of its own, lists its saves along the line,\n" +
      "newest first. Start somewhere else by naming a line or a save.\n\n" +
      "Anywhere else, lists what has been saved to the project on CodeRook,\n" +
      "as `cbx versions` does.",
    options: [
      { flags: "--limit <n>", description: "how many to show (default 20)" },
      { flags: "--versions", description: "on CodeRook: only the ones that were named" },
      { flags: "--commits", description: "on CodeRook: only the ones that were not" },
      { flags: "--notes", description: "on CodeRook: print what each one says about itself" },
    ],
    examples: ["cbx log", "cbx log feature --limit 5"],
    run: localFirst(localLog, commandVersions),
  },
  {
    name: "restore",
    group: "History on this machine",
    summary: "put files back the way a save had them",
    usage: "restore [paths…] [--from <save>]",
    detail:
      "With no paths, makes the whole folder match the save; with paths,\n" +
      "only those files and folders. The default is the last save, which\n" +
      "throws away what you changed since.\n\n" +
      "Unsaved changes to a file it would overwrite stop it, and it lists\n" +
      "them. Add --force to discard them. Files the history has never held\n" +
      "are left alone either way, and your line does not move.",
    options: [
      { flags: "--from <save>", description: "a line, line~N, or the start of a save id" },
      { flags: "-f, --force", description: "overwrite unsaved changes" },
    ],
    examples: ["cbx restore src/player.ts --force", "cbx restore --from main~3"],
    run: commandRestore,
  },
  {
    name: "switch",
    group: "History on this machine",
    summary: "move this folder to another line of work",
    usage: "switch [line]",
    detail:
      "In a folder with a history of its own, rewrites only the files the two\n" +
      "lines disagree about; unsaved edits elsewhere come along. Unsaved\n" +
      "edits to a file it would change stop it. -c starts a new line from the\n" +
      "current save without changing any files. With no line, lists them.\n\n" +
      "Anywhere else, changes the CodeRook line this folder saves to, as\n" +
      "`cbx track` does.",
    options: [
      { flags: "-c, --create", description: "start a new line here" },
      { flags: "-f, --force", description: "discard unsaved changes that are in the way" },
      { flags: "-n, --new", description: "on CodeRook: start this line from where the project is now" },
    ],
    examples: ["cbx switch", "cbx switch -c spike", "cbx switch main"],
    run: localFirst(localSwitch, commandTrack),
  },
  {
    name: "unlink",
    group: "Working with a folder",
    summary: "detach this folder from its project",
    usage: "unlink [folder]",
    detail:
      "Forgets which project this folder belongs to. Nothing is deleted:\n" +
      "the files here are untouched and the project stays on your account.\n\n" +
      "Mostly useful when a folder points at a project that is gone — one\n" +
      "that was deleted, or shared with you and since withdrawn — because\n" +
      "until the folder forgets it, every command asks about a project that\n" +
      "is no longer there.",
    examples: ["cbx unlink", "cbx unlink ./old-copy"],
    run: commandUnlink,
  },
  {
    name: "import",
    group: "Getting started",
    summary: "bring a project in from another host",
    usage: "import <address> [folder]",
    detail:
      "Fetches a repository from GitHub, GitLab or anywhere else git can\n" +
      "reach, and saves it as the first version of a CodeRook project.\n\n" +
      "The files come across; the history does not. Every past commit would\n" +
      "have to be published as its own version, which on a large project\n" +
      "takes days — so this takes an honest snapshot rather than leaving a\n" +
      "half-finished import behind. What arrives is the current state of the\n" +
      "default branch.\n\n" +
      "A public repository needs nothing. A private one uses the credentials\n" +
      "git already has on this machine; CodeRook never asks for, stores or\n" +
      "forwards a token.\n\n" +
      "Files that the project's own ignore rules exclude are sent anyway,\n" +
      "because git keeps tracking anything committed before the rule that\n" +
      "excludes it, and leaving them out would lose files the source has.",
    options: [
      { flags: "-m, --message <text>", description: "the first version's message" },
      { flags: "--track <name>", description: "save onto this line" },
      {
        flags: "--no-licence",
        description: "do not add a licence to the new project",
      },
    ],
    examples: [
      "cbx import https://github.com/owner/project",
      "cbx import git@github.com:owner/project.git ./project",
    ],
    run: commandImport,
  },
  {
    /*
      Distinct from `import`, which takes a snapshot. This moves the history,
      the branches, the tags and what the project says about itself — the
      things somebody leaving a host is actually worried about losing.
    */
    name: "transfer",
    aliases: ["migrate"],
    group: "Getting started",
    summary: "move a whole repository here from GitHub, GitLab or Codeberg",
    usage: "transfer <address>",
    detail:
      "Brings the commits, every branch, the tags and the description across.\n" +
      "Each commit becomes a version and each branch a line, so a long history\n" +
      "takes a while; the count and an estimate are printed before it starts.\n\n" +
      "The history is published by running `git push` against the CodeRook\n" +
      "remote — the same route anybody else uses, deliberately, because the\n" +
      "claim being made is that git repositories work here.\n\n" +
      "A private repository needs a read token in the environment:\n" +
      "GITHUB_TOKEN, GITLAB_TOKEN or FORGE_TOKEN. It is never asked for on the\n" +
      "command line and never stored.\n\n" +
      "The project is created private whatever the source was, unless you say\n" +
      "otherwise. Pull requests, CI configuration and collaborators do not come\n" +
      "across; the report at the end lists what did and what did not.",
    options: [
      { flags: "--name <name>", description: "call the project this, rather than the repository's name" },
      {
        flags: "--visibility <how>",
        description: "private (default), same as the source, or public",
      },
      { flags: "--issues", description: "also bring the open issues; needs a read token" },
    ],
    examples: [
      "cbx transfer https://github.com/owner/project",
      "cbx transfer https://codeberg.org/owner/project --visibility same",
    ],
    run: commandTransfer,
  },
  {
    /*
      Where the next save goes, which is a property of this folder rather
      than of the account — two checkouts of one project can sit on
      different lines, which is most of the point of having them.
    */
    name: "track",
    aliases: ["checkout"],
    group: "Working with a folder",
    summary: "show or change the line this folder saves to",
    usage: "track [name]",
    detail:
      "With no name, prints the line this folder saves to. With one, switches\n" +
      "to it. Switching says where the next save goes and nothing else: no\n" +
      "files move and nothing is fetched, so it is instant and safe to change\n" +
      "your mind. Run `cbx get` afterwards to bring that line's files\n" +
      "into the folder.\n\n" +
      "A name that does not exist is refused rather than created, because a\n" +
      "typo in a branch name is an ordinary thing to do and a line called\n" +
      "`mian` puts work somewhere nobody will look for it. Pass --new to\n" +
      "start one deliberately.",
    options: [
      { flags: "-n, --new", description: "start this line from where the project is now" },
    ],
    examples: ["cbx track", "cbx track spike --new", "cbx track main"],
    run: commandTrack,
  },
  {
    name: "tracks",
    aliases: ["branch", "branches"],
    group: "Your projects",
    summary: "the lines a project has, and any waiting on a decision",
    usage: "tracks [project]",
    detail:
      "Lists every line on the project, marking the one this folder saves to.\n" +
      "Merges waiting on a decision are listed beside them rather than hidden,\n" +
      "because somebody looking for where they can save needs to see the one\n" +
      "they cannot. Finish one with `cbx merge`.",
    examples: ["cbx tracks", "cbx tracks my-project"],
    run: commandTracks,
  },
  {
    name: "get",
    group: "Working with a folder",
    summary: "bring this folder up to date",
    usage: "get [folder]",
    options: [
      { flags: "--replace", description: "make it an exact copy, discarding local changes" },
    ],
    run: commandGet,
  },
  {
    name: "clone",
    group: "Working with a folder",
    summary: "fetch a project into a new folder",
    usage: "clone <project> [dir]",
    options: [
      {
        flags: "--track <name>",
        description: "fetch this line rather than the project's newest version",
      },
    ],
    examples: ["cbx clone my-project", "cbx clone my-project --track spike"],
    run: commandClone,
  },
  {
    name: "licence",
    aliases: ["license"],
    group: "Working with a folder",
    summary: "choose a licence, so people may actually use your work",
    usage: "licence [name] [folder]",
    detail:
      "A project with no licence cannot be used by anybody, whatever else it\n" +
      "says: with nothing granting permission, the law grants none. That is\n" +
      "the state most public projects are in, and the people most careful\n" +
      "about it are the ones who quietly walk away.\n" +
      "\n" +
      "Run it with no name to see what there is, each with a line saying what\n" +
      "it lets people do. Naming one writes LICENSE into the folder, and it\n" +
      "goes up with your next save like any other file.\n" +
      "\n" +
      "The texts are SPDX's own. Nothing here is paraphrased, because the\n" +
      "wording of a licence is the licence.\n",
    options: [
      {
        flags: "--holder <name>",
        description: "whose name goes on it, instead of your account name",
      },
      {
        flags: "--force",
        description: "replace a licence that is already there",
      },
    ],
    examples: ["cbx licence", "cbx licence MIT", "cbx licence Apache-2.0"],
    run: commandLicence,
  },
  {
    name: "ignore",
    aliases: ["rules"],
    group: "Working with a folder",
    summary: "show the ignore rules for this folder",
    usage: "ignore [folder]",
    detail:
      "The local list of things not to send — build output, dependencies,\n" +
      "anything private. Unrelated to a project's rules on the service, which\n" +
      "are about who may do what.",
    options: [
      { flags: "--init", description: "write a starting set of rules" },
      {
        flags: "--suggest",
        description: "list what is here that probably should not be sent",
      },
      {
        flags: "--apply",
        description: "with --suggest, add the confident ones to .gitignore",
      },
      {
        flags: "--template <name>",
        description:
          "add a ready-made set of rules; `list` shows all 309 of them",
      },
    ],
    run: (parsed) =>
      /*
        Two commands under one name, because they are one question. Somebody
        asking about ignore rules either wants to see what theirs are or wants
        a set they do not have to write, and making the second a separate
        command would hide it from the person who needs it most.
      */
      parsed.flags.has("template")
        ? commandIgnoreTemplate(parsed)
        : commandRules(parsed),
  },
  {
    name: "projects",
    group: "Your projects",
    summary: "every project on your account",
    usage: "projects",
    run: () => commandProjects(),
  },
  {
    name: "versions",
    group: "Your projects",
    summary: "what has been saved to a project",
    usage: "versions [project]",
    detail:
      "Newest first. Run it inside a linked folder to leave the name out.\n\n" +
      "A save is a commit; a commit somebody named is a version, and versions\n" +
      "are the only thing the public side shows. Both are listed together\n" +
      "unless you ask for one lane — the same three views the website has.",
    options: [
      { flags: "--limit <n>", description: "how many to show (default 20)" },
      { flags: "--versions", description: "only the ones that were named" },
      { flags: "--commits", description: "only the ones that were not" },
      { flags: "--notes", description: "print what each one says about itself" },
    ],
    examples: [
      "cbx versions --versions",
      "cbx versions my-project --commits",
    ],
    run: commandVersions,
  },
  {
    name: "ai",
    group: "Your projects",
    summary: "what this project says about machines",
    usage: "ai [project] [--read off]",
    detail:
      "Shows the four answers a project gives about automated clients, and\n" +
      "changes them. Everything is allowed until you say otherwise.\n\n" +
      "Turning reading off is the one that refuses model training: it declares\n" +
      "the project as not-for-training in the page, in the response headers,\n" +
      "and in the service's robots.txt. Turning downloads off does not — those\n" +
      "are separate questions and answering one says nothing about the other.",
    options: [
      { flags: "--read [off]", description: "reading, indexing, summarising, training" },
      { flags: "--download [off]", description: "taking the files" },
      { flags: "--contribute [off]", description: "automated contributions" },
      { flags: "--request [off]", description: "automated calls to its endpoints" },
    ],
    examples: [
      "cbx ai my-project",
      "cbx ai my-project --read off",
      "cbx ai my-project --download off --request off",
    ],
    run: commandAi,
  },
  {
    /*
      Not `publish`, which already reaches `submit` and would read as a
      release. This is who can reach the project, and it is named for that.
    */
    name: "visibility",
    group: "Your projects",
    summary: "who can reach a project: private, link only or public",
    usage: "visibility [level] [project]",
    detail:
      "The level is public, unlisted or private. With none, says what the\n" +
      "project is set to now.\n\n" +
      "Private is you and the people you invite. Unlisted, which the website\n" +
      "calls link only, keeps it off your profile and out of search. Public\n" +
      "lists it on your profile, and its page offers the saves somebody named\n" +
      "and did not hide.\n\n" +
      "Opening a project up asks first and says what becomes readable: the\n" +
      "named versions nobody hid, and nothing else. Going private asks\n" +
      "nothing.",
    options: [
      { flags: "-y, --yes", description: "open it up without asking, for scripts" },
    ],
    examples: [
      "cbx visibility",
      "cbx visibility public",
      "cbx visibility unlisted my-project --yes",
      "cbx visibility private my-project",
    ],
    run: commandVisibility,
  },
  {
    name: "pages",
    group: "Your projects",
    summary: "serve a public project as a website",
    usage: "pages [auto|on|off] [project]",
    detail:
      "With no word, says whether the project's site is on, its address, which\n" +
      "version it serves, from which folder, and anything stopping it.\n\n" +
      "auto finds the build in the newest published version — a Unity WebGL\n" +
      "build, a Godot web export, a Vite or React build, or plain HTML — and\n" +
      "turns the site on with it. When nothing published looks like a site and\n" +
      "you are in the project's folder, it looks here instead: a build left out\n" +
      "by the ignore rules is named, with the .gitignore line that keeps it in.\n" +
      "It never saves or publishes for you.\n\n" +
      "on and auto ask first, because the site runs the project's code in\n" +
      "anybody's browser under its name. Only published versions are served,\n" +
      "the project must be public, and only its owner can change the site.\n" +
      "off asks nothing.",
    options: [
      { flags: "--folder <path>", description: "on: where index.html is; . for the top" },
      { flags: "--spa", description: "on: unknown paths serve index.html (--no-spa undoes)" },
      { flags: "--isolate", description: "on: cross-origin isolation, for Godot 4 threads (--no-isolate)" },
      { flags: "--version <n|id>", description: "on: serve this version rather than the newest published" },
      { flags: "-y, --yes", description: "turn it on, or change .gitignore, without asking" },
    ],
    examples: [
      "cbx pages",
      "cbx pages auto",
      "cbx pages on my-game --folder Build/WebGL --isolate",
      "cbx pages on --version 12 --yes",
      "cbx pages off",
    ],
    run: commandPages,
  },
  {
    name: "issues",
    group: "Your projects",
    summary: "issues on a project, or open one",
    usage: "issues [project]",
    detail:
      "Labels are given when the issue is opened rather than added\n" +
      "afterwards, and any name that does not exist yet is created.\n\n" +
      "--version says which save it is about. \"It broke\" and \"it broke in\n" +
      "v41\" are different reports, and the second is the one somebody can\n" +
      "act on.",
    options: [
      { flags: '--new "<title>"', description: "open a new issue" },
      { flags: "--body <text>", description: "the description for a new one" },
      { flags: "--labels <a,b>", description: "labels for a new one, comma separated" },
      { flags: "--version <n>", description: "which save it is about" },
    ],
    examples: [
      'cbx issues my-project --new "Crash on export"',
      'cbx issues --new "Installer will not run" --labels bug,windows --version 41',
    ],
    run: commandIssues,
  },
  {
    name: "releases",
    aliases: ["tags"],
    group: "Your projects",
    summary: "what has been released, and its files",
    usage: "releases [project]",
    run: commandReleases,
  },
  {
    /*
      The service has been able to notify something else since Merge Tracks
      shipped — queue an event, sign it, deliver it after the request that
      caused it — and nothing could reach it, so no project could be told to
      tell a build box or a status page anything.
    */
    name: "hooks",
    aliases: ["webhooks"],
    group: "Your projects",
    summary: "where this project tells something else what happened",
    usage: "hooks [project]",
    detail:
      "A signed POST to an address of yours when something happens here.\n" +
      "The signing secret is generated by the service and shown once, when\n" +
      "the hook is added — no route hands it back afterwards.\n\n" +
      "Events: version.published, merge.opened, merge.applied, merge.cancelled,\n" +
      "check.reported, change_request.opened, change_request.reviewed.\n" +
      "Naming none of them sends all of them.",
    options: [
      { flags: "--add <url>", description: "notify this address; https only" },
      { flags: "--events <a,b>", description: "only these, comma separated" },
      { flags: "--remove <id>", description: "stop notifying it" },
      { flags: "--project <name>", description: "which project" },
    ],
    examples: [
      "cbx hooks",
      "cbx hooks --add https://example.com/coderook",
      "cbx hooks --add https://example.com/builds --events version.published",
    ],
    run: commandHooks,
  },
  {
    /*
      The half that hiding never covered.

      Hiding a bad push stops strangers reading it and leaves the project
      standing on it, so the next person to pull still lands on the mistake.
      This moves the project.
    */
    name: "undo",
    group: "Your projects",
    summary: "put the project back on an earlier save",
    usage: "undo [n] [project]",
    detail:
      "Goes back one save unless you name another to go back to.\n\n" +
      "Nothing is deleted and nothing is renumbered — the saves that get\n" +
      "passed over stay in the history, and the next save carries on from\n" +
      "wherever the project now stands.",
    examples: ["cbx undo", "cbx undo 41"],
    run: commandUndo,
  },
  {
    /*
      The decision that separates a working history from a published one.

      Every save is a commit and most of them are nobody else's business. This
      is where one becomes a version — the thing the public side of a project
      actually offers.
    */
    name: "promote",
    group: "Your projects",
    summary: "turn a commit into a version people can fetch",
    usage: "promote [n] [project]",
    detail:
      "Shows the last ten commits and asks which one. Give a number to skip\n" +
      "the list.\n\n" +
      "A version is a commit with a name on it. Until a project promotes its\n" +
      "first one its public page shows everything, as it always did.",
    options: [
      { flags: "--name <text>", description: "what to call it" },
      { flags: "--notes <text>", description: "what changed" },
      { flags: "--notes-file <path>", description: "what changed, from a file" },
      { flags: "--edit", description: "write what changed in your editor" },
    ],
    examples: [
      "cbx promote",
      "cbx promote 41 --name v2.1",
      'cbx promote --name "Client build" --notes "Fixes the export dialog"',
    ],
    run: commandPromote,
  },
  {
    /*
      One command for everything a version can be, because the service takes
      one patch. Three separate commands would be three requests, and three
      chances for a person to end up with a version that is named but not
      pinned because the second one failed.
    */
    /*
      Not called "version".

      `cbx version` has printed the version number since the first release,
      and quietly changing that when arguments follow is the kind of thing
      that works until somebody scripts it. This marks a save — pins it,
      hides it, labels it — which is what it does anyway.
    */
    name: "attach",
    group: "Your projects",
    summary: "put a file people can download on a version",
    usage: "attach <file> [n] [project]",
    detail:
      "A version can carry downloads — an installer, a build, a changelog —\n" +
      "and until now the only thing that could put one there was a workflow\n" +
      "run. This attaches a file from this machine.\n\n" +
      "Attaching is not publishing. A download on a commit is reachable by\n" +
      "nobody until that commit is made a version; on a version already\n" +
      "offered it is public the moment it lands.\n\n" +
      "Large files go up in parts, so a 95 MB installer works the same way a\n" +
      "text file does.",
    options: [
      { flags: "--name <text>", description: "call it something else on the version" },
      { flags: "--project <name>", description: "which project" },
    ],
    examples: [
      "cbx attach ./release/Installer-1.0.exe",
      "cbx attach ./release/app.dmg 41",
      'cbx attach ./notes.pdf --name "Release notes.pdf"',
    ],
    run: commandAttach,
  },
  {
    name: "notes",
    aliases: ["release-notes"],
    group: "Your projects",
    summary: "read or write what a version says about itself",
    usage: "notes [n] [project]",
    detail:
      "The release info the website shows on a version, and the same field\n" +
      "`--notes` writes when promoting. With nothing to write it prints what\n" +
      "is there, which the terminal could not do before: `cbx releases` shows\n" +
      "the first line and stops.\n\n" +
      "Written in Markdown, because that is what the page renders. --edit\n" +
      "opens $EDITOR (or $VISUAL, or notepad on Windows) the way git does,\n" +
      "which is the only comfortable way to write more than a sentence.",
    options: [
      { flags: "--edit", description: "write it in your editor" },
      { flags: "--notes-file <path>", description: "take the text from a file" },
      { flags: "--notes <text>", description: "set it in one line" },
      { flags: "--clear", description: "remove what is there" },
      { flags: "--project <name>", description: "which project" },
    ],
    examples: [
      "cbx notes",
      "cbx notes 41",
      "cbx notes 41 --edit",
      "cbx notes 41 --notes-file RELEASE.md",
    ],
    run: commandNotes,
  },
  {
    name: "mark",
    aliases: ["set"],
    group: "Your projects",
    summary: "name, hide, pin or label one save",
    usage: "mark [n] [project]",
    detail:
      "Changes the newest version unless you name another.\n" +
      "Everything you ask for happens in one request, so it either all\n" +
      "lands or none of it does.",
    options: [
      { flags: "--name <text>", description: "give it a code name" },
      { flags: "--unname", description: "take the name off again" },
      { flags: "--notes <text>", description: "what changed" },
      { flags: "--notes-file <path>", description: "what changed, from a file" },
      { flags: "--edit", description: "write what changed in your editor" },
      { flags: "--hide", description: "nobody outside the project can read it" },
      { flags: "--show", description: "anybody can read it" },
      {
        flags: "--visibility <who>",
        description: "public, or private to hold it back",
      },
      { flags: "--pin", description: "keep it at the top of the list" },
      { flags: "--unpin", description: "put it back in order" },
      { flags: "--labels <a,b>", description: "the labels it should wear" },
      { flags: "--clear-labels", description: "take them all off" },
    ],
    examples: [
      "cbx mark --name v2.1 --pin",
      "cbx mark 41 --visibility private",
      'cbx mark 41 --labels "shipped,client work"',
    ],
    run: commandVersion,
  },
  {
    name: "labels",
    group: "Your projects",
    summary: "the labels this project puts on versions",
    usage: "labels [list|add|remove] [name] [colour]",
    detail:
      "A label is a name and a colour. Put as many on a version as you like —\n" +
      "how you group and colour your own history is yours to decide.",
    examples: [
      "cbx labels",
      "cbx labels add shipped green",
      "cbx labels add urgent #e0574a",
      "cbx labels remove shipped",
    ],
    run: commandLabels,
  },
  {
    name: "held",
    aliases: ["waiting"],
    group: "Your projects",
    summary: "versions waiting for somebody to approve them",
    usage: "held [project]",
    detail:
      "A project can be set to hold pushes from anyone below admin until an\n" +
      "admin accepts them. Those versions are real and stored — they are just\n" +
      "not the current version, and not on the public page.",
    run: commandHeld,
  },
  {
    name: "review",
    group: "Your projects",
    summary: "accept a held version, or turn it down",
    usage: "review <n> --approve | --decline",
    options: [
      {
        flags: "--approve",
        description: "accept it; it becomes the current version",
      },
      { flags: "--decline", description: "turn it down" },
      { flags: "--note <text>", description: "why" },
    ],
    examples: [
      "cbx review 41 --approve",
      'cbx review 41 --decline --note "wrong branch"',
    ],
    run: commandReview,
  },
  {
    /*
      Named for what it does rather than "delete", because it does not delete
      the version. The files go; the version stays in the history as a gap
      saying what was removed and by whom.
    */
    name: "take-down",
    group: "Your projects",
    summary: "remove a version's files, for something published by mistake",
    usage: "take-down <n> --yes",
    detail:
      "The files go and do not come back. The version stays in the history as\n" +
      "a gap saying what was removed and by whom, so nothing is quietly\n" +
      "rewritten.",
    options: [
      { flags: "--yes", description: "confirm; without it nothing happens" },
      { flags: "--reason <text>", description: "recorded against the gap" },
    ],
    run: commandTakeDown,
  },
  {
    /*
      A release is a version with a name on it, so this names one rather than
      creating anything. Pushing a git tag does the same thing by the same
      route — the tag is the name, the tagged commit picks the version.
    */
    name: "release",
    aliases: ["tag"],
    group: "Your projects",
    summary: "give a version a name, so people know which one to fetch",
    usage: "release <name> [project]",
    detail:
      "Names the newest version unless you name another with --version.\n" +
      "Nothing is uploaded: a release is a version with a name on it, so the\n" +
      "version has to exist already.\n\n" +
      "The same thing happens when a git tag is pushed to a CodeRook remote —\n" +
      "`git push cbx v1.0` and `cbx release v1.0` are one action.",
    options: [
      { flags: "--version <n>", description: "name this version instead of the newest" },
      { flags: "--notes <text>", description: "what changed, for the release page" },
    ],
    examples: [
      "cbx release v1.0",
      'cbx release v1.2 --version 41 --notes "Fixes the export dialog"',
    ],
    run: commandRelease,
  },
  {
    name: "actions",
    aliases: ["workflows"],
    group: "Your projects",
    summary: "the automations a project has",
    usage: "actions [project]",
    detail:
      "Shows what each action runs, what it runs on, and how many of its\n" +
      "runs have passed. Use `cbx runner` to execute them on this machine.\n\n" +
      "An action that keeps files can hand them straight to the version it\n" +
      "ran against, so a passing build becomes a download without anybody\n" +
      "opening the website. --ship turns that on for one action.\n\n" +
      "Attaching is publishing: what an action ships onto a public version\n" +
      "is a download anybody can take, from the moment the run passes.",
    options: [
      { flags: "--ship <action>", description: "its builds become downloads on the version" },
      { flags: "--no-ship <action>", description: "keep its files without attaching them" },
      { flags: "--on-save <action>", description: "run it on every save" },
      { flags: "--on-proposal <action>", description: "run it on proposals; its result becomes a check" },
      { flags: "--by-hand <action>", description: "run it only when somebody starts it" },
      { flags: "--project <name>", description: "which project" },
    ],
    examples: [
      "cbx actions",
      'cbx actions --ship "Windows installer"',
      'cbx actions --no-ship "Windows installer"',
      'cbx actions --on-proposal Tests',
    ],
    run: commandWorkflows,
  },
  {
    name: "runs",
    group: "Actions",
    summary: "what has run, and how it went",
    usage: "runs [project]",
    detail:
      "Newest first, with the machine that took each one. A run that is still\n" +
      "going shows the runner holding it, which is the first thing worth\n" +
      "knowing when one is taking longer than it should.",
    options: [
      {
        flags: "--status <state>",
        description: "queued, running, passed, failed or cancelled",
      },
    ],
    examples: ["cbx runs --status failed"],
    run: commandRuns,
  },
  {
    name: "logs",
    group: "Actions",
    summary: "what one run printed",
    usage: "logs <number> [project]",
    detail:
      "The output the runner sent up, in order. Anything the command wrote to\n" +
      "stderr is shown in red. Exits 1 when the run failed, so this can be\n" +
      "the last line of a script.",
    examples: ["cbx logs 12", "cbx logs #12 my-project"],
    run: commandLogs,
  },
  {
    name: "delete",
    group: "Your projects",
    summary: "delete a project",
    usage: "delete [project]",
    detail:
      "Asks for the project name to be typed before it does anything. The\n" +
      "service keeps deleted projects for 30 days before reclaiming the\n" +
      "storage, so a mistake made today is recoverable this month.",
    options: [{ flags: "--yes", description: "skip the confirmation" }],
    run: commandDelete,
  },
  {
    name: "people",
    aliases: ["collaborators"],
    group: "People",
    summary: "who can reach a project, and invite somebody",
    usage: "people [project]",
    options: [
      { flags: "--invite <email>", description: "ask somebody to join" },
      { flags: "--role <role>", description: "what they may do (default member)" },
    ],
    examples: ["cbx people my-project --invite sam@example.com"],
    run: commandCollaborators,
  },
  {
    name: "watch",
    group: "People",
    summary: "what reaches you about a project",
    usage: "watch [project] [--level versions]",
    options: [
      {
        flags: "--level <level>",
        description: "everything, versions, issues, releases, ignore",
      },
      { flags: "--email [off]", description: "include it in the daily email" },
    ],
    run: commandWatch,
  },
  {
    name: "tokens",
    group: "Other",
    summary: "the tokens that can act as your account",
    usage: "tokens",
    detail:
      "Lists personal access tokens with when each was last used, which is\n" +
      "how you find one that is no longer needed. Create new ones on the\n" +
      "website; they are only shown once.",
    options: [{ flags: "--revoke <id>", description: "stop one working now" }],
    run: commandTokens,
  },
  {
    name: "propose",
    group: "Working with a folder",
    summary: "offer this folder's line to main",
    usage: 'propose -m "title" [--into main] [--body text] [folder]',
    options: [
      { flags: "-m, --message <text>", description: "the proposal's title" },
      { flags: "--into <line>", description: "the line to propose into (default main)" },
      { flags: "--from <line>", description: "propose this line instead of the folder's" },
      { flags: "--body <text>", description: "a longer description" },
    ],
    detail:
      "Opens a proposal from the line this folder is on into main (or --into).\n" +
      "Files both sides changed are combined line by line where they can be;\n" +
      "the rest wait for a decision in cbx merge. \"Fixes #12\" in the title or\n" +
      "body closes issue 12 when the proposal lands.",
    run: commandPropose,
  },
  {
    name: "proposals",
    group: "Working with a folder",
    summary: "open proposals on this project",
    usage: "proposals [--all] [folder]",
    options: [{ flags: "--all", description: "include merged and cancelled ones" }],
    run: commandProposals,
  },
  {
    name: "merges",
    group: "When somebody saved first",
    summary: "this folder's uploads waiting on a decision",
    usage: "merges [folder]",
    detail:
      "Both merge commands read the project this folder is linked to, so run\n" +
      "them from a working copy — or name one.",
    run: commandMerges,
  },
  {
    name: "merge",
    group: "When somebody saved first",
    summary: "merge a line here, or decide one waiting on CodeRook",
    usage: "merge <line | ref>",
    detail:
      "In a folder with a history of its own, merges a line or a save into\n" +
      "this one. What only one side changed is taken; a text file both\n" +
      "changed is merged line by line; only what is left is a conflict,\n" +
      "marked in the file. Fix them and save, or take a side whole with\n" +
      "--mine or --theirs, or call it off with --cancel.\n\n" +
      "Anywhere else, decides a merge waiting on CodeRook.",
    options: [
      { flags: "-m, --message <text>", description: "what the merge save says" },
      { flags: "--abort", description: "the same as --cancel" },
      { flags: "--mine", description: "keep your side" },
      { flags: "--theirs", description: "keep theirs" },
      { flags: "--both", description: "keep both" },
      { flags: "--drop", description: "abandon the upload" },
      { flags: "--path <file>", description: "decide one file rather than every one outstanding" },
      { flags: "--cancel", description: "call the merge off; your upload stays stored" },
      { flags: "--ask <usernames>", description: "ask people to review it, comma separated" },
    ],
    run: localFirst(localMerge, commandMerge),
  },
  {
    name: "bundle",
    group: "Bundles",
    summary: "pack the project as a .cbx",
    usage: "bundle [folder] [out]",
    run: commandBundle,
  },
  {
    name: "unbundle",
    group: "Bundles",
    summary: "extract a .cbx",
    usage: "unbundle <file> [dir]",
    run: commandUnbundle,
  },
  {
    name: "inspect",
    group: "Bundles",
    summary: "what a .cbx contains",
    usage: "inspect <file>",
    options: [{ flags: "--files", description: "list every file inside" }],
    run: commandInspect,
  },
  {
    name: "runner",
    group: "Actions",
    summary: "take this project's runs and do them here",
    usage: "runner <project>",
    detail:
      "Claims queued runs for a project and executes them on this machine.\n" +
      "Credentials in your environment are not passed to the commands it runs.",
    options: [
      { flags: "--once", description: "do one job and stop" },
      { flags: "--name <label>", description: "how this machine is listed" },
      { flags: "--labels <a,b>", description: "what kinds of run it answers to" },
      { flags: "--poll <seconds>", description: "how long between asks" },
    ],
    examples: ["cbx runner my-game --labels windows,signing"],
    run: commandRunner,
  },
  {
    /*
      The other way to hand this to an assistant is a plugin marketplace,
      and marketplaces live in git repositories — an odd thing to require
      of people using a version host that is deliberately not git. A skill
      is a file in a folder, and this already knows where the folder is.
    */
    name: "skill",
    group: "Other",
    summary: "teach Claude Code about CodeRook",
    usage: "skill [--project]",
    detail:
      "Writes a short guide into Claude Code's skills folder, so it knows what\n" +
      "CodeRook is and how to drive it. After that you ask for it in words:\n" +
      "'save this to CodeRook', 'what changed?' — or run it by name with\n" +
      "/coderook.\n" +
      "\n" +
      "Personal by default, so it is there in every project on this machine.\n" +
      "--project writes it into ./.claude instead, where it travels with the\n" +
      "repository for everybody who clones it.\n" +
      "\n" +
      "It teaches the command line rather than the MCP server, because that\n" +
      "needs no configuration at all. `cbx mcp` is still there when a\n" +
      "structured connection is wanted.\n",
    options: [
      {
        flags: "--project",
        description: "install into this project rather than for you",
      },
    ],
    examples: ["cbx skill", "cbx skill --project"],
    run: commandSkill,
  },
  {
    /*
      The assistants speak one protocol between them, so this is one server
      rather than two integrations. Hidden from nobody but unlikely to be
      typed by hand: it is launched by Claude Code or Codex, talks on its own
      stdin and stdout, and exits with them.
    */
    name: "mcp",
    group: "Other",
    summary: "serve CodeRook to Claude Code, Codex and other assistants",
    usage: "mcp",
    detail:
      "Speaks the Model Context Protocol on stdin and stdout, so an assistant\n" +
      "can look at your projects while it works. Not run by hand — point the\n" +
      "assistant at it and it starts and stops the process itself.\n" +
      "\n" +
      "Claude Code:\n" +
      "  claude mcp add coderook -- cbx mcp\n" +
      "\n" +
      "Codex, in ~/.codex/config.toml:\n" +
      "  [mcp_servers.coderook]\n" +
      "  command = 'cbx'\n" +
      "  args = ['mcp']\n" +
      "\n" +
      "Everything it offers reads. It lists projects, versions and files, shows\n" +
      "one file at a version, and reports what has changed in a folder. It\n" +
      "cannot save a version, delete anything, or sign in or out — an assistant\n" +
      "that goes wrong can waste your time but not your work.\n" +
      "\n" +
      "A project whose owner has turned off machine reading is refused, in\n" +
      "words rather than as a status code.\n",
    examples: ["claude mcp add coderook -- cbx mcp"],
    run: () => commandMcp(VERSION),
  },
  {
    name: "doctor",
    group: "Other",
    summary: "check the service, config and sign-in",
    usage: "doctor",
    run: () => commandDoctor(),
  },
];

/*
  `push` and `pull` mean the local history in a folder that has one, and
  `submit` and `get` everywhere else, which is what they always meant. Built
  from those two rows so every option they take still parses when the name
  falls through to them.
*/
function localTwin(
  name: string,
  original: string,
  local: Parameters<typeof localFirst>[0],
  row: Pick<CommandSpec, "summary" | "usage" | "detail" | "examples">,
  extra: NonNullable<CommandSpec["options"]>,
): CommandSpec {
  const spec = SPECS.find((one) => one.name === original)!;
  const taken = new Set(extra.map((one) => one.flags));
  return {
    name,
    group: "History on this machine",
    ...row,
    options: [...extra, ...(spec.options ?? []).filter((one) => !taken.has(one.flags))],
    run: localFirst(local, spec.run),
  };
}

SPECS.push(
  localTwin(
    "push",
    "submit",
    localPush,
    {
      summary: "send this line's saves to CodeRook",
      usage: "push",
      detail:
        "In a folder with a history of its own, sends each save on this line that\n" +
        "CodeRook does not have yet, oldest first, as a save of its own. Only\n" +
        "what changed in each is sent. The first push creates the project,\n" +
        "private, unless the folder is already linked to one.\n\n" +
        "If CodeRook's line has saves this history does not, nothing is sent:\n" +
        "run `cbx pull` first.\n\n" +
        "Anywhere else, this is `cbx submit`.",
      examples: ["cbx push", "cbx push --allow-secrets"],
    },
    [{ flags: "-y, --yes", description: "go ahead past the checks that ask first" }],
  ),
  localTwin(
    "pull",
    "get",
    localPull,
    {
      summary: "bring CodeRook's saves on this line into this history",
      usage: "pull [project]",
      detail:
        "In a folder with a history of its own, fetches the saves CodeRook has on\n" +
        "this line and this history does not, and moves the folder to the newest.\n" +
        "Only files that differ are fetched and rewritten; an unsaved edit to\n" +
        "one of them stops it. Name a project to pull from it the first time.\n\n" +
        "If this history has saves CodeRook does not, CodeRook's are fetched\n" +
        "but the folder stays put: merging a local history is not built yet.\n\n" +
        "Anywhere else, this is `cbx get`.",
      examples: ["cbx pull", "cbx pull my-project"],
    },
    [{ flags: "-f, --force", description: "discard unsaved changes that are in the way" }],
  ),
);

const REGISTRY = buildRegistry(SPECS);

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (!name || name === "--help" || name === "-h") {
    console.log(renderHelp(REGISTRY, VERSION));
    return 0;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    console.log(VERSION);
    return 0;
  }

  /*
    `cbx help submit` and `cbx submit --help` reach the same page.
    People reach for both, and one of them silently doing something else is
    the kind of small betrayal that makes a tool feel unreliable.
  */
  if (name === "help") {
    const wanted = rest[0];
    if (!wanted) {
      console.log(renderHelp(REGISTRY, VERSION));
      return 0;
    }
    const spec = REGISTRY.lookup.get(wanted);
    if (!spec) {
      console.error(renderUnknown(wanted, nearestCommand(REGISTRY, wanted)));
      return 1;
    }
    console.log(renderCommandHelp(spec));
    return 0;
  }

  const spec = REGISTRY.lookup.get(name);
  if (!spec) {
    console.error(renderUnknown(name, nearestCommand(REGISTRY, name)));
    return 1;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(renderCommandHelp(spec));
    return 0;
  }

  if (spec.deprecatedBy) {
    console.error(
      dim(`"${name}" is now "${spec.deprecatedBy}". The old name still works.`),
    );
  }

  return spec.run(parse(rest, spec));
}

/**
 * Set the status and let Node wind down on its own.
 *
 * Calling process.exit here would race the sockets `fetch` keeps alive, and
 * on Windows that trips a libuv assertion which prints alarming noise after
 * a perfectly successful command. Unreferencing standard input is what lets
 * the process finish promptly once the work is done.
 */
function leave(code: number): void {
  process.exitCode = code;
}

main(process.argv.slice(2))
  .then(leave)
  .catch((error: unknown) => {
    console.error(red(error instanceof Error ? error.message : String(error)));
    leave(1);
  });
