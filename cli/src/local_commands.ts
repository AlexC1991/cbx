/**
 * The local history, from a terminal: `cbx init`, `save`, `restore`, and the
 * local side of `status`, `diff`, `log` and `switch`.
 *
 * None of these talk to CodeRook. A folder with a `.cbx/` history answers
 * `status`, `diff`, `log` and `switch` from it; a folder without one gets the
 * account-backed commands those names have always meant, so nothing anybody
 * already relies on changes until they run `cbx init`.
 */
import path from "node:path";
import process from "node:process";

import {
  cancelMerge,
  changeCount,
  merge,
  resolveConflicts,
  UnresolvedConflicts,
  diff,
  init,
  log,
  pathFilter,
  restore,
  save,
  status,
  switchLine,
  UnsavedChanges,
  type Changes,
} from "../../cbx/src/local/history.js";
import { readMergeState } from "../../cbx/src/local/merge.js";
import { Repository, type Save } from "../../cbx/src/local/repository.js";
import {
  NoRemote,
  pull,
  push,
  readRemote,
  RemoteAhead,
  RemoteDiffers,
} from "../../cbx/src/local/remote.js";

import { projectById } from "./api.js";
import { credentials, readLink, writeLink } from "./config.js";
import { chooseProject } from "./project_choice.js";
import { resolveProject } from "./project_commands.js";
import { classifyPublishFailure } from "./publish.js";
import type { Parsed } from "./registry.js";

const ESC = String.fromCharCode(27);
const paint = (code: string) => (value: string) => `${ESC}[${code}m${value}${ESC}[0m`;
const dim = paint("2");
const bold = paint("1");
const red = paint("31");
const green = paint("32");
const accent = paint("33");

const short = (id: string) => id.slice(0, 10);
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

function text(parsed: Parsed, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

const has = (parsed: Parsed, ...names: string[]) => names.some((name) => parsed.flags.has(name));

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

/** The history the working directory is in, if it is in one. */
export async function localHistory(from = process.cwd()): Promise<Repository | null> {
  return Repository.find(from);
}

/**
 * A command that means the local history in a folder that has one, and what
 * it has always meant everywhere else.
 */
export function localFirst(
  local: (parsed: Parsed, repository: Repository) => Promise<number>,
  otherwise: (parsed: Parsed) => Promise<number>,
  from: (parsed: Parsed) => string = () => process.cwd(),
): (parsed: Parsed) => Promise<number> {
  return async (parsed) => {
    const repository = await localHistory(from(parsed));
    return repository ? local(parsed, repository) : otherwise(parsed);
  };
}

function printChanges(changes: Changes, limit = 50): void {
  const rows: Array<[string, string]> = [
    ...changes.added.map((file): [string, string] => [green("added   "), file]),
    ...changes.modified.map((file): [string, string] => [accent("changed "), file]),
    ...changes.deleted.map((file): [string, string] => [red("deleted "), file]),
  ].sort((left, right) => (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  for (const [mark, file] of rows.slice(0, limit)) console.log(`  ${mark}${file}`);
  if (rows.length > limit) console.log(dim(`  … and ${rows.length - limit} more`));
}

function describeSave(one: Save): string {
  const when = new Date(one.created);
  const date = Number.isNaN(when.getTime())
    ? one.created
    : when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `${accent(short(one.id))}  ${one.message.split("\n")[0]}  ${dim(`${one.author} · ${date}`)}`;
}

/** Refusals are printed as sentences, not stack traces. */
async function reporting(work: () => Promise<number>): Promise<number> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RemoteAhead || error instanceof RemoteDiffers || error instanceof NoRemote) {
      console.error(red(error.message));
      return 1;
    }
    const failure = classifyPublishFailure(error);
    if (failure?.kind === "credentials") {
      console.error(red(failure.message));
      console.error(
        dim("Take the key out of that save, or push it deliberately with --allow-secrets."),
      );
      return 1;
    }
    if (failure?.kind === "interrupted") {
      console.error(red(`The connection failed part way: ${failure.message}`));
      console.error(dim("Push again. Saves already on CodeRook are not sent twice."));
      return 1;
    }
    if (error instanceof UnsavedChanges || error instanceof UnresolvedConflicts) {
      console.error(red(error.message));
      for (const file of error.files.slice(0, 20)) console.error(`  ${file}`);
      if (error.files.length > 20) console.error(dim(`  … and ${error.files.length - 20} more`));
      return 1;
    }
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

/* ---- init ------------------------------------------------------------ */

export async function commandInit(parsed: Parsed): Promise<number> {
  return reporting(async () => {
    const folder = path.resolve(parsed.positional[0] ?? process.cwd());
    const inside = await localHistory(folder);
    if (inside && inside.root !== folder) {
      console.error(
        red(`${folder} is already inside the history at ${inside.root}.`),
      );
      console.error(dim("One history per project. Run cbx commands from anywhere inside it."));
      return 1;
    }
    const repository = await init(folder, text(parsed, "line") ?? undefined);
    console.log(
      `Started a history in ${bold(repository.root)} on ${accent(await repository.currentLine())}.`,
    );
    console.log(
      dim(
        "It lives in .cbx/ and never leaves this machine by itself. Run " +
          `cbx save -m "…" to record the folder as it is.`,
      ),
    );
    return 0;
  });
}

/* ---- save ------------------------------------------------------------ */

export async function commandSave(parsed: Parsed): Promise<number> {
  return reporting(async () => {
    const repository = await Repository.open(process.cwd());
    const message = text(parsed, "m", "message") ?? "";
    const merging = await readMergeState(repository);
    if (!message.trim() && !merging) {
      console.error(red('A save needs a message: cbx save -m "what changed"'));
      return 1;
    }
    const interactive = process.stdout.isTTY;
    let shown = 0;
    const result = await save(repository, {
      message,
      force: has(parsed, "force", "f"),
      author: text(parsed, "author"),
      progress: interactive
        ? (done, total) => {
            const now = Date.now();
            if (now - shown < 100 && done < total) return;
            shown = now;
            process.stdout.write(`\r${dim(`Reading ${done.toLocaleString()} of ${total.toLocaleString()} files`)}   `);
          }
        : undefined,
    });
    if (interactive) process.stdout.write(`\r${" ".repeat(60)}\r`);
    if (!result.saved) {
      console.log("Nothing has changed since the last save, so there is nothing to record.");
      return 0;
    }
    const count = changeCount(result.changes);
    console.log(
      `Saved ${accent(short(result.save.id))} on ${accent(result.save.line)}: ` +
        `${result.save.message.split("\n")[0]}`,
    );
    console.log(
      dim(
        `${plural(count, "file")} changed · ${plural(result.files, "file")}, ` +
          `${bytes(result.bytes)} in the save`,
      ),
    );
    printChanges(result.changes, 20);
    return 0;
  });
}

/* ---- status ---------------------------------------------------------- */

export async function localStatus(_parsed: Parsed, repository: Repository): Promise<number> {
  return reporting(async () => {
    const now = await status(repository);
    console.log(
      `${bold(path.basename(repository.root))} on ${accent(now.line)}` +
        (now.head ? dim(`  last saved ${short(now.head.id)}: ${now.head.message.split("\n")[0]}`) : dim("  nothing saved yet")),
    );
    if (now.merging) {
      const left = now.merging.unresolved.length;
      console.log(
        `Merging ${accent(short(now.merging.theirs))}: ` +
          (left ? red(`${plural(left, "file")} still ${left === 1 ? "has" : "have"} conflict markers`) : green("no conflict markers left")),
      );
      for (const conflict of now.merging.conflicts) {
        const how =
          conflict.kind === "text"
            ? now.merging.unresolved.includes(conflict.path) ? "markers in it" : "edited"
            : conflict.kind === "binary"
              ? "both changed; this line's copy is in the folder"
              : conflict.kind === "deleted-here"
                ? "deleted here, changed there; their copy is in the folder"
                : "changed here, deleted there; this copy is in the folder";
        console.log(`  ${red("conflict")} ${conflict.path}  ${dim(how)}`);
      }
      console.log(dim(`Finish with cbx save, take a side with cbx merge --mine or --theirs, or cbx merge --cancel.`));
    }
    const count = changeCount(now.changes);
    if (!count) {
      console.log("Nothing has changed since the last save.");
      return 0;
    }
    console.log(`${plural(count, "file")} changed since the last save:`);
    printChanges(now.changes);
    console.log(dim(`cbx diff shows the lines; cbx save -m "…" records them.`));
    return 0;
  });
}

/* ---- log ------------------------------------------------------------- */

export async function localLog(parsed: Parsed, repository: Repository): Promise<number> {
  return reporting(async () => {
    const limit = Number(text(parsed, "limit") ?? 20);
    const saves = await log(repository, {
      from: parsed.positional[0],
      limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    });
    if (!saves.length) {
      console.log(`Nothing saved on ${accent(await repository.currentLine())} yet.`);
      return 0;
    }
    for (const one of saves) console.log(describeSave(one));
    return 0;
  });
}

/* ---- diff ------------------------------------------------------------ */

export async function localDiff(parsed: Parsed, repository: Repository): Promise<number> {
  return reporting(async () => {
    const [from, to] = parsed.positional;
    const contains = text(parsed, "path");
    const context = Number(text(parsed, "context") ?? 3);
    const changes = await diff(repository, {
      from,
      to,
      only: contains ? (file) => file.includes(contains) : undefined,
      context: Number.isFinite(context) && context >= 0 ? context : 3,
    });
    if (!changes.length) {
      console.log(to ? "Those two saves hold the same files." : "Nothing has changed since the last save.");
      return 0;
    }
    const mark = { added: green("+"), modified: accent("~"), deleted: red("-") };
    for (const change of changes) {
      console.log(`${mark[change.kind]} ${bold(change.path)}`);
      if (has(parsed, "name-only")) continue;
      if (change.executableChanged) console.log(dim("    execute permission changed"));
      if (change.summary) {
        console.log(dim(`    ${change.summary}`));
        continue;
      }
      for (const chunk of change.chunks ?? []) {
        if (chunk.kind === "gap") {
          console.log(dim(`    ... ${chunk.skipped} unchanged`));
          continue;
        }
        for (const line of chunk.lines) {
          const at = String(line.candidateLine ?? line.targetLine ?? "").padStart(5);
          if (line.side === "same") console.log(dim(`${at}   ${line.text}`));
          else if (line.side === "candidate") console.log(`${dim(at)} ${green("+")} ${green(line.text)}`);
          else console.log(`${dim(at)} ${red("-")} ${red(line.text)}`);
        }
      }
    }
    return 0;
  });
}

/* ---- restore --------------------------------------------------------- */

export async function commandRestore(parsed: Parsed): Promise<number> {
  return reporting(async () => {
    const repository = await Repository.open(process.cwd());
    const from = text(parsed, "from");
    const result = await restore(repository, {
      from,
      only: pathFilter(repository, parsed.positional),
      force: has(parsed, "force", "f"),
    });
    const touched = result.written.length + result.removed.length;
    if (!touched) {
      console.log(`Already matches ${accent(short(result.save.id))}; nothing to put back.`);
      return 0;
    }
    console.log(
      `Put back ${plural(touched, "file")} from ${accent(short(result.save.id))}: ` +
        `${result.save.message.split("\n")[0]}`,
    );
    for (const file of result.written.slice(0, 20)) console.log(`  ${green("restored")} ${file}`);
    for (const file of result.removed.slice(0, 20)) console.log(`  ${red("removed ")} ${file}`);
    if (touched > 40) console.log(dim(`  … and more`));
    console.log(dim("Your line has not moved. Save to record the folder as it is now."));
    return 0;
  });
}

/* ---- switch ---------------------------------------------------------- */

export async function localSwitch(parsed: Parsed, repository: Repository): Promise<number> {
  return reporting(async () => {
    const line = parsed.positional[0];
    if (!line) {
      const current = await repository.currentLine();
      for (const one of await repository.lines()) {
        console.log(
          `${one.name === current ? accent("*") : " "} ${one.name}  ${dim(short(one.tip))}`,
        );
      }
      if (!(await repository.lineExists(current))) {
        console.log(`${accent("*")} ${current}  ${dim("nothing saved yet")}`);
      }
      return 0;
    }
    const result = await switchLine(repository, line, {
      create: has(parsed, "c", "create", "new", "n"),
      force: has(parsed, "force", "f"),
    });
    if (result.created) {
      console.log(
        `Started ${accent(result.line)}` +
          (result.save ? ` from ${accent(short(result.save.id))}.` : ".") +
          dim(" No files changed."),
      );
      return 0;
    }
    const touched = result.written.length + result.removed.length;
    console.log(
      `On ${accent(result.line)} now` +
        (touched ? `, ${plural(touched, "file")} changed.` : ", and no files needed changing."),
    );
    return 0;
  });
}

/* ---- push and pull ---------------------------------------------------- */

/**
 * Keep the folder's CodeRook link in step with what a push or pull made, so
 * `cbx submit` and `cbx get` in the same folder start from the same place.
 */
async function recordLink(
  repository: Repository,
  line: string,
  repositoryId: string,
  head: { versionId: string; sequence: number },
  manifest: Record<string, string>,
): Promise<void> {
  const link = await readLink(repository.root);
  const slug =
    (await projectById(repositoryId).catch(() => null))?.slug ??
    link?.slug ??
    path.basename(repository.root);
  await writeLink(repository.root, {
    ...(link ?? {}),
    repositoryId,
    slug,
    sequence: head.sequence,
    track: line,
    versionId: head.versionId,
    baseVersionId: head.versionId,
    observedHeadVersionId: head.versionId,
    manifest,
    local: manifest,
  });
}

export async function localPush(parsed: Parsed, repository: Repository): Promise<number> {
  return reporting(async () => {
    const link = await readLink(repository.root);
    /*
      A history that has never been pushed, in a folder linked to nothing,
      is asked which project it belongs to, as `cbx submit` asks: naming it
      after the folder joined any project that shared the name.
    */
    let chosen: Awaited<ReturnType<typeof chooseProject>> = null;
    if (!link && !(await readRemote(repository)).repositoryId) {
      const into = parsed.flags.get("into");
      const named = parsed.flags.get("name");
      chosen = await chooseProject({
        folder: repository.root,
        name: typeof named === "string" ? named : path.basename(repository.root),
        ...(typeof into === "string" ? { into } : {}),
        startNew: has(parsed, "new"),
        command: "cbx push",
      });
      if (!chosen) return 1;
    }
    const interactive = process.stdout.isTTY;
    const result = await push(repository, {
      credentials,
      projectName:
        link?.slug ?? (chosen ? ("id" in chosen ? chosen.slug : chosen.name) : path.basename(repository.root)),
      repositoryId: link?.repositoryId ?? (chosen && "id" in chosen ? chosen.id : null),
      joinExisting: false,
      allowSecrets: has(parsed, "allow-secrets"),
      acknowledged: has(parsed, "yes", "y"),
      report: (event) => {
        if (event.kind === "save" && interactive) {
          process.stdout.write(
            `\r${dim(`Sending ${event.index + 1} of ${event.total}: ${event.save.message.split("\n")[0]!.slice(0, 50)}`)}   `,
          );
        }
        if (event.kind === "pushed" || event.kind === "unchanged") {
          if (interactive) process.stdout.write(`\r${" ".repeat(80)}\r`);
          console.log(
            `  ${accent(short(event.save.id))}  ` +
              (event.kind === "pushed" ? green(`v${event.sequence}`) : dim("already there")) +
              `  ${event.save.message.split("\n")[0]}`,
          );
        }
      },
    });
    if (!result.pushed.length) {
      console.log(`Everything on ${accent(result.line)} is already on CodeRook.`);
      return 0;
    }
    const last = result.pushed[result.pushed.length - 1]!;
    console.log(
      `Pushed ${plural(result.pushed.length, "save")} to CodeRook on ${accent(result.line)}; ` +
        `it is at ${accent(`v${last.sequence}`)} now.`,
    );
    if (result.repositoryId && result.head) {
      await recordLink(repository, result.line, result.repositoryId, result.head, result.head.manifest);
    }
    return 0;
  });
}

export async function localPull(parsed: Parsed, repository: Repository): Promise<number> {
  return reporting(async () => {
    let repositoryId = (await readRemote(repository)).repositoryId;
    const named = parsed.positional[0];
    if (named) {
      const project = await resolveProject(named);
      if (!project) return 1;
      repositoryId = project.id;
    }
    repositoryId ??= (await readLink(repository.root))?.repositoryId ?? null;
    const interactive = process.stdout.isTTY;
    const result = await pull(repository, {
      credentials,
      repositoryId,
      force: has(parsed, "force", "f"),
      report: (event) => {
        if (!interactive) return;
        if (event.kind === "version") {
          process.stdout.write(
            `\r${dim(`Fetching v${event.version.sequence} (${event.index + 1} of ${event.total})`)}${" ".repeat(20)}`,
          );
        }
      },
    });
    if (interactive) process.stdout.write(`\r${" ".repeat(80)}\r`);
    for (const save of result.imported) console.log(`  ${describeSave(save)}`);
    if (result.merged?.conflicts) {
      console.log(
        `CodeRook's ${accent(result.line)} and this history had both moved on, and merging them left ` +
          red(plural(result.merged.conflicts.length, "conflict")) + ":",
      );
      for (const conflict of result.merged.conflicts) console.log(`  ${red("conflict")} ${conflict.path}`);
      console.log(dim("Fix them, then cbx save and cbx push. cbx status lists them; cbx merge --cancel calls it off."));
      return 1;
    }
    if (result.merged?.save) {
      const touched = result.written.length + result.removed.length;
      console.log(
        `Merged ${plural(result.imported.length, "save")} from CodeRook's ${accent(result.line)} with this history's own` +
          (touched ? `; ${plural(touched, "file")} changed.` : ".") +
          ` Push to send the merge.`,
      );
      return 0;
    }
    if (!result.moved) {
      console.log(
        result.imported.length
          ? `Fetched ${plural(result.imported.length, "save")}.`
          : `Already up to date with CodeRook's ${accent(result.line)}.`,
      );
      return 0;
    }
    const touched = result.written.length + result.removed.length;
    console.log(
      `Pulled ${plural(result.imported.length, "save")} on ${accent(result.line)}` +
        (touched ? `; ${plural(touched, "file")} changed.` : "."),
    );
    const pulledFrom = (await readRemote(repository)).repositoryId;
    const tip = await repository.head();
    if (pulledFrom && result.head && tip) {
      const tree = await repository.readTree((await repository.readSave(tip)).tree);
      const manifest = Object.fromEntries(tree.files.map((file) => [file.path, file.sha256]));
      await recordLink(repository, result.line, pulledFrom, result.head, manifest);
    }
    return 0;
  });
}

/* ---- merge ------------------------------------------------------------ */

export async function localMerge(parsed: Parsed, repository: Repository): Promise<number> {
  return reporting(async () => {
    if (has(parsed, "cancel", "abort")) {
      const put = await cancelMerge(repository);
      console.log(`Merge called off; ${plural(put.length, "file")} put back as the last save had them.`);
      return 0;
    }
    const pathText = text(parsed, "path");
    const only = pathText ? pathFilter(repository, [pathText]) : undefined;
    for (const side of ["mine", "theirs"] as const) {
      if (!has(parsed, side)) continue;
      const settled = await resolveConflicts(repository, side, only);
      console.log(
        `Took ${side === "mine" ? "this line's" : "the other"} side of ${plural(settled.length, "file")}:`,
      );
      for (const file of settled) console.log(`  ${file}`);
      console.log(dim("Save when the rest are settled."));
      return 0;
    }
    const other = parsed.positional[0];
    if (!other) {
      console.error(red("Merge what? Name a line or a save: cbx merge feature"));
      return 1;
    }
    const outcome = await merge(repository, other, { message: text(parsed, "m", "message") });
    const touched = (outcome.kind === "up-to-date" ? 0 : outcome.written.length + outcome.removed.length);
    if (outcome.kind === "up-to-date") {
      console.log(`${other} is already part of this line.`);
    } else if (outcome.kind === "fast-forward") {
      console.log(`Moved to ${accent(short(outcome.save.id))}; ${plural(touched, "file")} changed. Nothing needed merging.`);
    } else if (outcome.kind === "merged") {
      console.log(`Merged ${accent(other)} as ${accent(short(outcome.save.id))}; ${plural(touched, "file")} changed.`);
    } else {
      console.log(`Merged what could be merged; ${red(plural(outcome.state.conflicts.length, "conflict"))} left:`);
      for (const conflict of outcome.state.conflicts) console.log(`  ${red("conflict")} ${conflict.path}`);
      console.log(dim("Fix them, then cbx save. Or take a side: cbx merge --theirs [--path file]. Or cbx merge --cancel."));
      return 1;
    }
    return 0;
  });
}
