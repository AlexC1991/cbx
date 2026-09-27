/** Reading a project folder: changed files, diffs, and rule measurement. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ChangedFile,
  ExcludedItem,
  FilterRules,
  Hunk,
  RuleEvaluation,
  SyncMode,
  TreeNode,
} from "../shared/types.js";
import {
  STARTER_TOPUP_HEADING,
  SUGGESTED_HEADING,
  templatesFor,
} from "./detect.js";
import { IGNORE_TEMPLATES } from "./ignore_templates.js";
import {
  decide,
  decidingRule,
  type FolderAnswers,
  excludes,
  isUncounted,
  negationReachesInto,
  parseRules,
  type RuleLayer,
} from "./rules.js";
import {
  findCredentials,
  looksLikeText,
  maskAssignedValues,
  maskCredentials,
  type CredentialFinding,
  worthReading,
} from "./secret_patterns.js";

const run = promisify(execFile);

/* A code point, so nothing between here and disk can eat the escape. */
const NEWLINE = String.fromCharCode(10);

/** Past this the evaluation reports truncated rather than walking forever. */
export const EVALUATION_FILE_LIMIT = 300_000;

async function git(root: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", root, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * A starter template, offered rather than imposed: these lines are written
 * into the project's own .gitignore, so nothing is hidden in the client.
 *
 * Credentials are deliberately absent. Silently omitting a configuration
 * file would produce an incomplete project that looked backed up, so likely
 * secrets are warned about instead (docs/UPLOAD_POLICY.md).
 */
export const STARTER_MARKER = "# CodeRook starter rules — edit freely below";

/**
 * What github/gitignore has no template for, kept beside whichever it picks.
 *
 * A browser or Electron profile left in a project folder holds files another
 * program keeps open — a LOCK that cannot be read while it runs will stop a
 * save outright — and none of it is the work. No language template mentions
 * them, because no language puts them there.
 */
/**
 * Where CodeRook and git want different things, and CodeRook wins.
 *
 * A .gitignore is written for a repository, where an archive is something you
 * could rebuild from the source beside it, so github/gitignore leaves
 * `*.unitypackage` out. CodeRook is not that. A version here is meant to be
 * the whole of a folder, and an asset-store package sitting inside `Assets`
 * is not rebuildable from anything in the project — it is a thing somebody
 * bought, and on the other machine it would simply be gone.
 *
 * Measured on a real project: forty-two of them, one per render pipeline and
 * Unity version, all inside `Assets`. Exactly the kind of "missing stuff"
 * that a save is supposed to make impossible.
 *
 * The `.meta` line guards against this application's own layering, and
 * nothing more. Unity's template keeps metas; `*.meta` is build output to
 * Visual Studio and its template says so, and a Unity folder has a .sln in it
 * because Unity writes one. Placed after every template so it is the last
 * word among the rules we stack — it cannot, and should not, outrank a line
 * somebody writes in their own file afterwards.
 */
/**
 * Caches and weights the chosen template has no reason to mention.
 *
 * A github/gitignore template is written for a repository on that platform,
 * not for every way somebody lays a project out. Xcode is the plain case:
 * DerivedData normally sits in your home folder, so GitHub never mentions it,
 * and a project configured to keep it alongside the source sent seven
 * thousand files of build output that the old generic list had caught.
 *
 * Anchored, every one of them. `models/` unanchored is what used to reach
 * into a Unity project's `Assets/Art/models`, which is the whole reason any
 * of this was looked at.
 */
export const ALSO_LEFT_OUT_HEADING =
  "# Also left out by CodeRook: caches and weights no template mentions.";

export const ALSO_LEFT_OUT = `/DerivedData/
/models/
*.safetensors
*.ckpt
*.pt
*.pth`;

export const KEPT_ANYWAY_HEADING =
  "# Kept even though the template leaves them out: not rebuildable from this folder.";

export const KEPT_ANYWAY = `!/[Aa]ssets/**/*.meta
!/[Aa]ssets/**/*.unitypackage
!/[Aa]ssets/**/*.unitypackage.meta`;

export const CODEROOK_TAIL_HEADING = "# Left out by CodeRook, whatever the project is.";

export const CODEROOK_TAIL = `IndexedDB/
Local Storage/
Session Storage/
Service Worker/
Network/
GPUCache/
Code Cache/
blob_storage/
Local State
Preferences

# Archives of the project, inside the project
*.cbx`;

export const STARTER_IGNORE = `${STARTER_MARKER}

# Dependencies and generated output
node_modules/
dist/
build/
out/
.next/
target/
__pycache__/
.venv/
venv/
*.log

# What a game engine rebuilds for itself. These are the largest thing in a
# folder by a wide margin — a Unity project's Library is routinely thousands
# of times the size of its Assets — and every byte comes back the next time
# the editor opens. Left out of this list for a long time, which meant a
# folder with no rules of its own sent its whole cache and nobody was told.
/[Ll]ibrary/
/[Tt]emp/
/[Ll]ogs/
/[Uu]ser[Ss]ettings/
/[Mm]emoryCaptures/
Intermediate/
DerivedDataCache/
Binaries/
.godot/
.import/

# Compiler and editor output, which the next build writes again.
obj/
.vs/
.gradle/
DerivedData/

# Large model weights
models/**
*.safetensors
*.ckpt
*.pt
*.pth

# Caches and local state
.pytest_cache/
.mypy_cache/
.ruff_cache/
.cache/
*.pyc

# A browser or Electron profile that has been left in the project folder.
# These hold files another program keeps open — a LOCK that cannot be read
# while it runs will stop a save outright — and nothing in them is the work.
IndexedDB/
Local Storage/
Session Storage/
Service Worker/
Network/
GPUCache/
Code Cache/
blob_storage/
Local State
Preferences

# Archives of the project, inside the project
*.cbx
`;

/**
 * Lines only this application writes, used to recognise its own handiwork.
 *
 * `*.cbx` is the strongest of them: a CodeRook bundle inside the project is a
 * CodeRook idea and nothing else puts that line in a .gitignore. The browser
 * profile names are the next best, because they are an unusual thing for a
 * person to think of and they arrive together.
 */
const STARTER_FINGERPRINT = [
  "IndexedDB/",
  "Local Storage/",
  "GPUCache/",
  "Code Cache/",
  "blob_storage/",
  "Local State",
  "Preferences",
];

/** Every rule in a block of text, without comments or blank lines. */
function ruleLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * What a rule line is about, with the parts that do not change the answer
 * taken off: the `!`, and a slash at either end.
 *
 * `output/`, `/output/` and `!output/` all name the same folder, and deciding
 * whether two lines disagree has to compare what they name rather than how they
 * were spelt — the detector writes one spelling, the filter screen another, and
 * a person a third.
 */
export function ruleTarget(line: string): string {
  return line.trim().replace(/^!/, "").replace(/^\/+|\/+$/g, "");
}

/** Every thing this file explicitly keeps, by {@link ruleTarget}. */
export function keptTargets(text: string): Set<string> {
  return new Set(
    ruleLines(text)
      .filter((line) => line.startsWith("!"))
      .map(ruleTarget),
  );
}

/**
 * The file without any line that says the opposite of `line` about the same
 * thing, and without a heading that is left with nothing under it.
 *
 * Needed because every writer here appends. A keep has to come after whatever
 * would take the file, and a new ignore after a keep beats it, so the last
 * word always wins — but the earlier word stayed in the file. A real project
 * ended up with `# Always include` / `!output/` directly above
 * `# Suggested for this folder, and accepted.` / `output/`: correct to a
 * matcher, and to anybody reading it, a file that says both things.
 *
 * Only the exact opposite goes. A broader rule — `*.log` above a kept
 * `!important.log` — is not about the same thing and is what makes the keep
 * mean anything, so it is left alone. Everything the removal did not touch is
 * returned byte for byte, line endings included.
 */
export function withoutOpposites(body: string, line: string): string {
  const target = ruleTarget(line);
  const keeping = line.trim().startsWith("!");
  const lines = body.split(NEWLINE);
  const plain = (at: number) => (lines[at] ?? "").trim();
  const isRule = (at: number) => plain(at).length > 0 && !plain(at).startsWith("#");
  const drop = new Set<number>();

  /* Paragraphs are runs of non-blank lines; a heading belongs to its own. */
  let start = 0;
  while (start < lines.length) {
    if (!plain(start)) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < lines.length && plain(end + 1)) end += 1;

    let touched = false;
    for (let at = start; at <= end; at += 1) {
      if (!isRule(at)) continue;
      const other = plain(at);
      if (ruleTarget(other) === target && other.startsWith("!") !== keeping) {
        drop.add(at);
        touched = true;
      }
    }
    /*
      A heading over nothing is a claim about nothing. Dropped with its
      paragraph, and one blank line beside it, so the file does not gather
      empty gaps where decisions used to be.
    */
    if (touched) {
      let left = false;
      for (let at = start; at <= end; at += 1) {
        if (isRule(at) && !drop.has(at)) left = true;
      }
      if (!left) {
        for (let at = start; at <= end; at += 1) drop.add(at);
        if (end + 1 < lines.length && !plain(end + 1)) drop.add(end + 1);
        else if (start > 0 && !plain(start - 1)) drop.add(start - 1);
      }
    }
    start = end + 1;
  }
  if (!drop.size) return body;
  return lines.filter((_line, at) => !drop.has(at)).join(NEWLINE);
}

/**
 * Whether this .gitignore was written by CodeRook rather than by a person.
 *
 * It matters because the starter template grows: engine caches were added to
 * it long after the first folders were set up, and those folders can never
 * benefit — a project with any .gitignore uses that file and nothing else. A
 * Unity project set up before the Unity rules existed therefore went on
 * sending its whole import cache for good, 45,342 files of it, with the
 * improved template sitting unused in this same file.
 *
 * Newly written starters carry STARTER_MARKER, so this is exact for anything
 * written from now on. The fingerprint is for the ones already on disk.
 */
export function starterAuthored(text: string): boolean {
  if (text.includes(STARTER_MARKER)) return true;
  const lines = new Set(ruleLines(text));
  if (!lines.has("*.cbx")) return false;
  const seen = STARTER_FINGERPRINT.filter((one) => lines.has(one)).length;
  return seen >= 3;
}

/**
 * The starter rules this file is missing, in template order.
 *
 * Only ever offered, never applied on its own: a person may have deleted a
 * line on purpose, and re-adding it silently would be this application
 * overruling them in their own file.
 */
export function missingStarterRules(text: string, reference = STARTER_IGNORE): string[] {
  const present = new Set(ruleLines(text));
  /*
    Not a line the person has already answered. A starter rule for something
    this file explicitly keeps is not missing, it was overruled — and offering
    it back would append it after the keep, where it wins, and take out the
    very thing somebody said to always include.
  */
  const kept = keptTargets(text);
  return ruleLines(reference).filter(
    (line) =>
      !present.has(line) && (line.startsWith("!") || !kept.has(ruleTarget(line))),
  );
}

/**
 * The rules this folder's own file is missing for the kind of project it is.
 *
 * The gap nothing could reach. A folder with a `.gitignore` of its own keeps
 * it — that is right, and a real one must always win — but it also meant that
 * every improvement to the rules could never arrive anywhere that needed
 * them. A Unity project whose file had been written before the engine rules
 * existed went on sending its whole import cache, and nothing said so.
 *
 * Reported rather than applied. A person may have deleted a line on purpose,
 * and putting it back without asking is this application overruling them in
 * their own file.
 */
export async function missingEngineRules(
  root: string,
): Promise<{ kind: string[]; missing: string[] }> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const kind = templatesFor(entries);
  if (!kind.length) return { kind, missing: [] };
  const shared = await readIfPresent(path.join(root, IGNORE_FILE));
  if (shared === null) return { kind, missing: [] };
  return { kind, missing: missingStarterRules(shared, await starterFor(root)) };
}

/** The shared rules file, committed with the project. */
export const IGNORE_FILE = ".gitignore";
/** Personal exclusions, which must never reach a collaborator. */
export const LOCAL_EXCLUDE_FILE = path.join(".git", "info", "exclude");

/** The two files an earlier build wrote, kept only so they can be migrated. */
const RETIRED_IGNORE = ".coderookignore";
const RETIRED_KEEP = ".coderookkeep";

async function readIfPresent(full: string): Promise<string | null> {
  try {
    const contents = await readFile(full, "utf8");
    return contents.trim() ? contents : null;
  } catch {
    return null;
  }
}

/** Whether the folder is a git repository, worktree or otherwise. */
export async function isRepository(root: string): Promise<boolean> {
  try {
    await stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** What git already tracks in a folder, and every folder that holds some of it. */
export type Tracked = { files: Set<string>; folders: Set<string> };

/** The label a file kept because git tracks it carries, where a rule would be. */
export const TRACKED_BY_GIT = "(tracked by git)";

/**
 * The files git tracks here, which an ignore rule does not take away.
 *
 * Git applies .gitignore only to files it does not track yet. Once a file is
 * committed, a rule written later — or a broad one like `storage/` that also
 * matches a source folder three levels down — leaves it exactly where it is.
 * This applied the rules to everything, so a project whose .gitignore said
 * `storage/` arrived without `internal/storage/*.go`: in git, whole; on
 * CodeRook, missing the six files that made it build.
 *
 * Null when the folder is not a repository, or git cannot be asked — then the
 * rules alone decide, as they always did.
 */
export async function gitTracked(root: string): Promise<Tracked | null> {
  if (!(await isRepository(root))) return null;
  const listed = await git(root, "ls-files", "-z");
  if (listed === null) return null;
  const files = new Set(listed.split(String.fromCharCode(0)).filter(Boolean));
  const folders = new Set<string>();
  for (const file of files) {
    for (let cut = file.lastIndexOf("/"); cut > 0; cut = file.lastIndexOf("/", cut - 1)) {
      const folder = file.slice(0, cut);
      if (folders.has(folder)) break;
      folders.add(folder);
    }
  }
  return { files, folders };
}

/**
 * Convert the rules an earlier build wrote into one .gitignore.
 *
 * `.coderookkeep` held "always include" lines, which gitignore expresses as
 * `!` negations, so those are translated rather than dropped. Nothing is
 * deleted here; the retired files are removed only once the new rules have
 * been written successfully.
 */
export function migrateRetiredRules(
  ignore: string | null,
  keep: string | null,
): string | null {
  if (!ignore && !keep) return null;
  const lines: string[] = [];
  if (ignore) lines.push(ignore.replace(/\s*$/, ""));
  const negations = (keep ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => (line.startsWith("!") ? line : `!${line}`));
  if (negations.length) {
    lines.push("", "# Always include (migrated from .coderookkeep)", ...negations);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The rules a folder gets when it has none of its own.
 *
 * github/gitignore's templates have been carried in this application all
 * along, and until now nothing chose one: every folder got the same generic
 * starter. For a game project that is the wrong list. It carries `build/`,
 * `dist/`, `out/` and `models/**` from the JavaScript and Python worlds, none
 * of them anchored, so a folder like `Assets/Art/models` or
 * `Assets/Plugins/Binaries` is matched by a rule that was written about
 * somewhere else entirely — and the files inside it are quietly not sent.
 *
 * So the folder is asked what it is, and the template that knows about its
 * layout is used. GitHub's Unity rules anchor every one of theirs — `/[Oo]bj/`
 * rather than `obj/` — precisely so they cannot reach into `Assets`.
 *
 * The starter still follows, for the things no language template covers: a
 * browser profile left in the folder, and CodeRook's own archives.
 */
/**
 * Engines github/gitignore has no template for.
 *
 * Kept deliberately small and anchored. An unanchored `library/` would reach
 * a folder of that name anywhere in the project, which is the mistake the
 * generic starter was already making.
 */
const EXTRA_TEMPLATES: Record<string, { name: string; body: string }> = {
  cocos: {
    name: "Cocos",
    body: `/[Ll]ibrary/
/[Tt]emp/
/[Bb]uild/
/.creator/`,
  },
};

export async function starterFor(root: string, chosen?: string | null): Promise<string> {
  /*
    What somebody said it is beats what the folder looks like.
    `none` is a real answer — "this is not any of those" — and gets the plain
    starter rather than being read as "no answer given".
  */
  const entries = await readdir(root).catch(() => [] as string[]);
  const keys = chosen ? (chosen === "none" ? [] : [chosen]) : templatesFor(entries);
  if (!keys.length) return STARTER_IGNORE;
  const parts = [STARTER_MARKER];
  for (const key of keys) {
    const template = IGNORE_TEMPLATES[key] ?? EXTRA_TEMPLATES[key];
    if (!template) continue;
    const from = IGNORE_TEMPLATES[key] ? ", from github/gitignore" : "";
    parts.push("", `# ${template.name}${from}`, template.body.trimEnd());
  }
  parts.push("", ALSO_LEFT_OUT_HEADING, ALSO_LEFT_OUT);
  parts.push("", KEPT_ANYWAY_HEADING, KEPT_ANYWAY);
  parts.push("", CODEROOK_TAIL_HEADING, CODEROOK_TAIL);
  return `${parts.join("\n")}\n`;
}

/**
 * Move one path onto the ignore list, or onto the keep list.
 *
 * Both are the same act — writing a line into the project's own rules — which
 * is why they are one function. Keeping means a `!` rule, and a `!` rule only
 * means anything if it comes after whatever would have taken the file, so the
 * line goes at the end under its own heading.
 *
 * Lifted out of the window's event handler so it can be tested. It could not
 * be before, which is how a folder came to be written as a rule that also
 * matched a file of the same name.
 */
export async function moveRule(
  root: string,
  file: string,
  keep: boolean,
): Promise<FilterRules> {
  /*
    The rules travel with the project. A .gitignore that excluded itself would
    never reach the website, the command line, or another machine.
  */
  if (file === IGNORE_FILE) {
    throw new Error("The ignore rules have to travel with the project");
  }
  const rules = await readRules(root);
  /*
    A folder is written as a folder rule.

    The path arrives without a trailing slash, and writing it as-is makes a
    rule that also matches a *file* of that name — not what anybody meant by
    excluding a directory, and a disagreement with what the command line
    prints for the same folder. Any slash already there is taken off first, so
    a caller passing a rule rather than a path cannot produce `name//`.
  */
  const bare = file.replace(/\/+$/, "");
  const directory = await stat(path.join(root, bare))
    .then((entry) => entry.isDirectory())
    .catch(() => file.endsWith("/"));
  /*
    A file git tracks cannot be ignored by a rule — git keeps it, and so does
    this. Writing the rule anyway would look like it worked and change
    nothing, so it is refused with what would actually leave it out.
  */
  if (!keep && !directory && (await gitTracked(root))?.files.has(bare)) {
    throw new Error(
      `git tracks ${bare}, so a rule cannot leave it out. Untick it for one ` +
        `save, or stop git tracking it: git rm --cached "${bare}"`,
    );
  }
  const target = directory ? `${bare}/` : bare;
  const line = keep ? `!${target}` : target;
  /*
    The opposite answer goes first. Moving a folder that was kept onto the
    ignore list used to add `output/` after `!output/` and leave both, so the
    file said both things and only the order decided which it meant.
  */
  const settled = withoutOpposites(rules.shared, line);
  /* Saying it twice changes nothing and makes the file harder to read. */
  const already = ruleLines(settled).some((one) => one === line);
  if (already) {
    if (settled === rules.shared) return rules;
    const next = { ...rules, shared: settled };
    await writeRules(root, next);
    return next;
  }
  const heading = keep ? KEEP_HEADING : IGNORE_HEADING;
  let body = settled.replace(/\s*$/, "");
  /*
    A keep inside an excluded folder needs the folder opened first.

    Rules cannot re-include a file whose directory is excluded — nothing ever
    looks inside a directory it has already decided to skip, so `!Library/x`
    under `Library/` does precisely nothing. That is most of what this button
    is for: rescuing one file out of a cache.

    The way through is the documented one. `Library/` becomes `Library/**`,
    which leaves the directory itself includable, and every directory on the
    way down to the file is named back in. Written here rather than asked of
    the person, because the alternative is a button that looks like it worked.
  */
  if (keep) {
    /*
      Which rule is in the way is a question for the matcher, not for string
      comparison. The line is `/[Ll]ibrary/` — a pattern — and no amount of
      comparing it against `Library/PackageCache/...` will ever match, which
      is exactly how the first version of this wrote a negation that did
      nothing at all.
    */
    const parts = target.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join("/");
      const layers = [{ base: "", rules: parseRules(body) }];
      const blocking = decide(ancestor, true, layers);
      if (!blocking || blocking.negated || !blocking.directoryOnly) continue;
      /*
        Replaced line by line rather than by pattern. The thing being found
        is itself a pattern — `/[Ll]ibrary/` — so building a regular
        expression out of it means escaping a string that is mostly regular
        expression already, for no gain over comparing the text.
      */
      const was = (blocking.anchored ? "/" : "") + blocking.pattern + "/";
      const opened = (blocking.anchored ? "/" : "") + blocking.pattern + "/**";
      body = body
        .split(NEWLINE)
        .map((one) => (one.trim() === was ? opened : one))
        .join(NEWLINE);
      /* Then name every directory between it and the file back in. */
      for (let at = depth; at < parts.length - 1; at += 1) {
        const open = "!" + parts.slice(0, at + 1).join("/") + "/";
        if (!ruleLines(body).includes(open)) body += NEWLINE + open;
      }
    }
  }
  const shared = body.includes(heading)
    ? body + NEWLINE + line + NEWLINE
    : body + NEWLINE + NEWLINE + heading + NEWLINE + line + NEWLINE;
  const next = { ...rules, shared };
  await writeRules(root, next);
  return next;
}

/**
 * Take the suggestions somebody accepted, and write them.
 *
 * The accepted patterns and the missing starter lines are written as two
 * labelled blocks rather than one, because they answer different questions:
 * one is "this folder holds a cache", the other is "the rules this folder
 * was set up with have moved on". A person reading the file later should be
 * able to tell which was which.
 *
 * Lifted out of the window's event handler for the same reason `moveRule` was:
 * inside it nothing could test it, and the defect it had — leaving the keep it
 * had just overruled in the file — was found by a person reading their own
 * .gitignore rather than by anything here.
 */
export async function acceptSuggestions(
  root: string,
  patterns: string[],
  starter: string[],
): Promise<FilterRules> {
  const rules = await readRules(root);
  /*
    A suggestion somebody accepts is their answer about that folder, and it
    replaces any earlier one. A real project kept `# Always include` /
    `!output/` directly above the `output/` the size prompt had just
    written: right to a matcher, because the later line wins, and to
    anybody reading the file a flat contradiction.

    Starter lines are the other way round. Nobody chose those one by one,
    so they never overrule a keep — `missingStarterRules` already leaves
    out anything kept, and this skips it again in case the file changed
    between the prompt being drawn and the button being pressed.
  */
  let settled = rules.shared;
  for (const pattern of patterns) settled = withoutOpposites(settled, pattern);
  const keptNow = keptTargets(settled);
  starter = starter.filter(
    (line) => line.startsWith("!") || !keptNow.has(ruleTarget(line)),
  );
  /*
    Added to, never stacked.

    The first version of this appended a fresh block every time, so a
    folder that grew a second cache later ended up with two identical
    headings and the same rule written twice — the same fault the template
    appender had already been fixed for. Lines that are already in the file
    are skipped, and a heading that is already there is extended under
    itself rather than repeated.
  */
  const has = new Set(
    settled
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const add = (heading: string, lines: string[]): string => {
    const wanted = lines.filter((line) => !has.has(line.trim()));
    if (!wanted.length) return "";
    for (const line of wanted) has.add(line.trim());
    return [heading, ...wanted].join("\n");
  };

  let shared = settled.replace(/\s*$/, "");
  for (const [heading, lines] of [
    [SUGGESTED_HEADING, patterns],
    [STARTER_TOPUP_HEADING, starter],
  ] as const) {
    const block = add(heading, lines);
    if (!block) continue;
    const at = shared.indexOf(heading);
    if (at === -1) {
      shared = shared ? `${shared}\n\n${block}` : block;
      continue;
    }
    /* Extend the block that is already there, directly under its heading. */
    const after = at + heading.length;
    shared =
      shared.slice(0, after) +
      block.slice(heading.length) +
      shared.slice(after);
  }
  const next = { ...rules, shared: `${shared}\n` };
  await writeRules(root, next);
  return next;
}

/** The two headings a move writes under, so a person can find their own edits. */
export const KEEP_HEADING = "# Always include";
export const IGNORE_HEADING = "# Left out from the filter screen";

export async function readRules(root: string): Promise<FilterRules> {
  const shared = await readIfPresent(path.join(root, IGNORE_FILE));
  const local = await readIfPresent(path.join(root, LOCAL_EXCLUDE_FILE));
  if (shared !== null) return { shared, local: local ?? "" };

  // No .gitignore yet. Anything an earlier build wrote is carried over, so a
  // project that was already set up does not silently lose its rules.
  const migrated = migrateRetiredRules(
    await readIfPresent(path.join(root, RETIRED_IGNORE)),
    await readIfPresent(path.join(root, RETIRED_KEEP)),
  );
  return { shared: migrated ?? (await starterFor(root)), local: local ?? "" };
}

/** Write the rules where the project, the CLI and git all expect them. */
export async function writeRules(root: string, rules: FilterRules): Promise<void> {
  await writeFile(path.join(root, IGNORE_FILE), rules.shared, "utf8");
  if (rules.local.trim() && (await isRepository(root))) {
    const target = path.join(root, LOCAL_EXCLUDE_FILE);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rules.local, "utf8");
  }
  // Only now that the real file exists are the retired ones removed.
  for (const retired of [RETIRED_IGNORE, RETIRED_KEEP]) {
    await rm(path.join(root, retired), { force: true });
  }
}

/**
 * Every .gitignore that governs this tree, root first. Nested files apply to
 * their own directory downwards and, being deeper, have the final say.
 */
export async function collectLayers(
  root: string,
  rules: FilterRules,
): Promise<RuleLayer[]> {
  const layers: RuleLayer[] = [
    // Personal exclusions sit at the root but must never be shared.
    ...(rules.local.trim() ? [{ base: "", rules: parseRules(rules.local) }] : []),
    { base: "", rules: parseRules(rules.shared) },
  ];

  const walk = async (directory: string, base: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isUncounted(entry.name) || entry.isSymbolicLink()) continue;
      const relative = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // A directory already excluded cannot contribute rules of its own.
        if (excludes(relative, true, layers)) continue;
        await walk(path.join(directory, entry.name), relative);
      } else if (entry.name === IGNORE_FILE && base) {
        const contents = await readIfPresent(path.join(directory, entry.name));
        if (contents) layers.push({ base, rules: parseRules(contents) });
      }
    }
  };
  await walk(root, "");
  return layers;
}

/** Fail loudly on a folder that is gone, rather than reporting it as empty. */
export async function assertReadable(root: string): Promise<void> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("not a folder");
  } catch {
    throw new Error(`${root} is not a folder this machine can read`);
  }
}

export async function branchName(root: string): Promise<string> {
  const output = await git(root, "branch", "--show-current");
  return output?.trim() || "main";
}

/**
 * What the last saved version contained: relative path to content hash.
 * Null when no version has ever been saved, which is not the same as an
 * empty one — at v0 the whole project is outstanding.
 */
export type Baseline = Map<string, string> | null;

/**
 * What each file looked like when it was last hashed.
 *
 * Taking a digest means reading the whole file, and a scan reads every file
 * in the project. That was survivable only because large files were skipped —
 * and skipping them is exactly the bug that made them permanently "changed".
 * Hashing them properly fixed the answer and made the question expensive: a
 * twenty-eight gigabyte project would read twenty-eight gigabytes to notice
 * that nothing had happened.
 *
 * So the digest is remembered alongside the size and modification time it was
 * taken from. A file whose size and mtime are unchanged has not been written
 * to, and its digest is reused rather than recomputed. This is the same trade
 * git makes in its index, and it fails in the same direction: a file altered
 * without its mtime moving is missed. That takes deliberate effort, and the
 * alternative is a scan nobody can afford to run.
 */
export type StatCache = Map<
  string,
  { size: number; mtimeMs: number; sha256: string }
>;

/** Files bigger than this are listed but not read to count their lines. */
const LINE_COUNT_LIMIT = 4 * 1024 * 1024;

/** Enough rows for any real project; past it the rail would be unusable. */
const LISTED_FILE_LIMIT = 20_000;

/**
 * What a capped scan could not fit, so the rail can say so.
 *
 * Passed in and filled, the same way `stats` is, rather than changing what
 * this returns — three callers want the rows and only one wants the count.
 */
export type ListingOutcome = {
  /*
    Whether the cap actually cut the list short.

    Distinct from `listed < total`, which is the ordinary case: `total` counts
    every file the rules would send and the list holds only the ones that
    changed, so an up-to-date folder is legitimately 0 of twenty thousand.
    Reading that difference as truncation made the rail announce "the first 0
    of 21,065 files" over a folder with nothing to do.
  */
  truncated?: boolean;
  /*
    How many rows to allow through, when the default is not wanted.

    Here so the cap can be exercised. It was twenty thousand and unreachable
    from a test, so the behaviour past it — which turned out to be a list of
    the wrong files and a save that left `Assets/` out — was never checked by
    anything, in a codebase that checks a great deal else.
  */
  limit?: number;
  listed: number;
  total: number;
  /*
    Every file the rules would send, with its size — the same thing
    `surveyFiles` returns, gathered on the way past.

    The exclusion suggestions need a size for every file in the folder, and
    getting it used to mean a second uncapped walk over a tree this one had
    just finished walking. One walk, statted once, measured only where the
    cap allows.
  */
  sizes: Array<{ path: string; size: number }>;
};

/**
 * The digest of a file, without holding it.
 *
 * Streamed because the files this exists for are the large ones, and reading
 * a gigabyte into memory in order to hash it is the reason it was not being
 * done at all.
 */
async function digestOf(full: string): Promise<string> {
  try {
    const hash = createHash("sha256");
    for await (const block of createReadStream(full, {
      highWaterMark: 4 * 1024 * 1024,
    })) {
      hash.update(block as Buffer);
    }
    return hash.digest("hex");
  } catch {
    return "";
  }
}

/**
 * How a file reads: its line count, whether it is binary, and its digest.
 *
 * The size decides only whether the lines are counted. It used to decide
 * whether the digest was taken as well, and those are not the same question:
 * counting lines needs the whole file in memory, which is a real reason to
 * stop at a few megabytes, while the digest is what decides whether the file
 * changed at all.
 *
 * Returning no digest for a large file therefore did not mean "not measured",
 * it meant "cannot match" — the comparison below skips a file only when its
 * digest equals the recorded one, and an empty string never does. So every
 * file over four megabytes was reported as changed on every scan, forever,
 * however untouched it was. A project holding two large files offered to
 * upload them again after each save, said "2 not uploaded yet" beside a panel
 * confirming the account already held them, and could not be talked out of it
 * by refreshing, because refreshing recomputed the same empty answer.
 */
async function measure(
  full: string,
  size: number,
  known?: {
    mtimeMs: number;
    cached?: { size: number; mtimeMs: number; sha256: string };
    /** Whether the record holds this path, and so whether a digest can match. */
    recorded?: boolean;
  },
): Promise<{ lines: number; binary: boolean; hash: string }> {
  /*
    Unchanged on disk, so unchanged in content. Checked before the size test
    because the whole point is to answer without reading, and the files worth
    not reading are the large ones.
  */
  const cached = known?.cached;
  if (cached && cached.size === size && cached.mtimeMs === known!.mtimeMs) {
    return { lines: 0, binary: true, hash: cached.sha256 };
  }
  if (size > LINE_COUNT_LIMIT) {
    /*
      Read only when the answer could be "unchanged".

      The digest exists to be compared against a recorded one. A file the
      record has never heard of is new whatever it hashes to, so taking the
      digest decides nothing and costs a full read of the file.

      That is most of what a first scan is. Hashing large files was necessary
      to stop them reading as changed forever, but doing it for files nothing
      could match turned opening a six hundred megabyte project for the first
      time into two minutes of reading to learn what the absence of a record
      already said.
    */
    if (!known?.recorded) return { lines: 0, binary: true, hash: "" };
    return { lines: 0, binary: true, hash: await digestOf(full) };
  }
  try {
    const contents = await readFile(full);
    const binary = contents.subarray(0, 8192).includes(0);
    return {
      lines: binary ? 0 : contents.toString("utf8").split(/\r?\n/).length,
      binary,
      hash: createHash("sha256").update(contents).digest("hex"),
    };
  } catch {
    return { lines: 0, binary: true, hash: "" };
  }
}

/**
 * The files that would go into the next version.
 *
 * This deliberately does not ask git. A CodeRook version is not a commit:
 * a folder that is not a repository at all still has everything to upload,
 * and a repository with a spotlessly clean worktree still has everything to
 * upload when no version has ever been saved. The filter rules decide what
 * is a candidate; the baseline decides what is new.
 */
/**
 * The same files, ordered so that a cap spends itself across the folder.
 *
 * Taken in walk order, a cap is handed to whichever directory the walk
 * reached first — and the directory a person cares about is rarely that one.
 * Round-robin by directory means the first row of every directory is chosen
 * before the second row of any, so a folder of forty-five thousand cache
 * files cannot bury the eight hundred beside it that are the work.
 */
function spreadAcrossDirectories<T extends { relative: string }>(
  found: readonly T[],
): T[] {
  const byDirectory = new Map<string, T[]>();
  for (const one of found) {
    const at = one.relative.slice(0, one.relative.lastIndexOf("/") + 1);
    const held = byDirectory.get(at);
    if (held) held.push(one);
    else byDirectory.set(at, [one]);
  }
  const queues = [...byDirectory.values()];
  const deepest = queues.reduce((most, queue) => Math.max(most, queue.length), 0);
  const spread: T[] = [];
  for (let round = 0; round < deepest; round++) {
    for (const queue of queues) {
      const one = queue[round];
      if (one) spread.push(one);
    }
  }
  return spread;
}

export async function changedFiles(
  root: string,
  rules: FilterRules,
  baseline: Baseline = null,
  mode: SyncMode = "add-and-update",
  /*
    Digests already taken, and what the files looked like when they were.
    Read and written in place, so the caller keeps whatever this learns and
    the next scan does not read the same unchanged gigabyte again.
  */
  stats?: StatCache,
  /** Filled with how much of the folder the cap allowed through. */
  outcome?: ListingOutcome,
): Promise<ChangedFile[]> {
  const layers = await collectLayers(root, rules);
  /* What git already tracks goes up whatever a rule says; see gitTracked. */
  const tracked = await gitTracked(root);
  const files: ChangedFile[] = [];
  const present = new Set<string>();
  const pending: string[] = [root];
  /** Everything the rules would send, including what the cap keeps out. */
  const found: Array<{
    full: string;
    relative: string;
    size: number;
    mtimeMs: number;
  }> = [];
  const limit = outcome?.limit ?? LISTED_FILE_LIMIT;

  /*
    Walk the whole folder first, and decide what to read afterwards.

    These used to be one pass: walk until twenty thousand rows had been
    collected, then stop where it stood. That made the cap decide the shape of
    the answer — the walk was depth first, so the first directory it descended
    into took the entire allowance. In a Unity project that is `Library/`,
    forty-five thousand files of import cache, and `Assets/` — the actual game
    — appeared in the list nowhere at all.

    Walking is cheap: a readdir and a stat, no file is opened. Reading is what
    costs, so reading is what the cap should govern, and it can only be spent
    well once the whole folder is known.
  */
  for (let next = 0; next < pending.length; next++) {
    const directory = pending[next]!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    const wanted: Array<{ full: string; relative: string }> = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (isUncounted(entry.name)) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");

      if (entry.isDirectory()) {
        // Skipping an excluded directory outright is what keeps this fast,
        // but a `!` rule exists to rescue what is inside one, so the subtree
        // is only skipped when no negation could reach into it.
        if (
          excludes(relative, true, layers) &&
          !negationReachesInto(relative, layers) &&
          !tracked?.folders.has(relative)
        ) {
          continue;
        }
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (excludes(relative, false, layers) && !tracked?.files.has(relative)) continue;
      wanted.push({ full, relative });
    }

    /*
      Sized a directory at a time rather than a file at a time. One `stat` is
      a syscall's round trip, and forty-seven thousand of them taken strictly
      one after another is most of the scan; asked for together they overlap.
    */
    const sized = await Promise.all(
      wanted.map(async (one) => {
        try {
          const info = await stat(one.full);
          return { ...one, size: info.size, mtimeMs: info.mtimeMs };
        } catch {
          /* Gone or unreadable since the walk began; the upload reports it. */
          return null;
        }
      }),
    );

    for (const one of sized) {
      if (!one) continue;
      /*
        Recorded as present for every file the walk saw, capped or not.

        Synchronize mode calls anything in the last version that is missing
        from this set a deletion. Filling it only for the rows that fitted
        meant a folder past the cap proposed deleting every file the cap had
        kept out — files sitting right there on disk.
      */
      present.add(one.relative);
      outcome?.sizes.push({ path: one.relative, size: one.size });
      found.push(one);
    }
  }

  /*
    Read in an order that gives every directory a share, and stop at the cap.

    An unchanged file costs a digest and produces no row, so this runs until
    the list is full rather than over a fixed slice — a folder where nothing
    has changed still has to be walked through to find that out.
  */
  for (const one of spreadAcrossDirectories(found)) {
    if (files.length >= limit) break;
    const { full, relative, size, mtimeMs } = one;

    const measured = await measure(full, size, {
      mtimeMs,
      cached: stats?.get(relative),
      recorded: baseline?.has(relative) ?? false,
    });
    /*
      Remembered whether or not it changed: the next scan wants to skip
      reading this file again, and that is just as true of one that was
      edited a moment ago as of one that never moves.
    */
    if (measured.hash) stats?.set(relative, { size, mtimeMs, sha256: measured.hash });
    const saved = baseline?.get(relative);
    if (saved && measured.hash && saved === measured.hash) continue;

    files.push({
      path: relative,
      // Against a saved version the true line delta needs the old copy;
      // until a version exists to fetch, a changed file counts as rewritten.
      added: measured.lines,
      removed: 0,
      included: true,
      binary: measured.binary,
    });
  }

  // A file that was in the last version and is gone now is only a change in
  // synchronize mode. The safe default adds and updates, and leaves the
  // saved copy of a missing file alone (docs/UPLOAD_POLICY.md).
  if (mode === "synchronize") {
    for (const [saved] of baseline ?? []) {
      if (present.has(saved)) continue;
      files.push({
        path: saved,
        added: 0,
        removed: 0,
        included: true,
        binary: false,
        deleted: true,
      });
    }
  }

  if (outcome) {
    outcome.listed = files.length;
    outcome.truncated = files.length >= limit;
    /*
      Deletions are rows the walk never saw, so they are added to both sides
      rather than left out of the total — otherwise a synchronize scan could
      report listing more files than the folder was found to hold.
    */
    outcome.total = Math.max(found.length, files.length);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** The size on disk of everything the rules would upload. */
/**
 * Every file the rules would upload, with its size and nothing else.
 *
 * Deliberately not `changedFiles`. That function stops at twenty thousand rows
 * because past it a list is unusable — a correct limit for a scrollbar and a
 * catastrophic one for deciding what gets backed up, which is what it was also
 * being used for. A project past that many files was silently uploaded in
 * part.
 *
 * This walk has no cap and reads nothing: no line counting, no hashing, no
 * content at all. That is what makes it affordable to run over everything
 * before deciding anything.
 */
export async function surveyFiles(
  root: string,
  rules: FilterRules,
  /*
    Told how many have been found, every so often.

    This walk is the first thing a save does and it can take a minute on a
    large folder — during which the only honest thing the progress panel
    could say was 0%, because nothing had told it otherwise. A count of what
    has been seen is not a fraction of anything, but it moves, and it is the
    difference between waiting and wondering whether it has hung.
  */
  onFound?: (found: number) => void,
): Promise<Array<{ path: string; size: number }>> {
  const layers = await collectLayers(root, rules);
  const tracked = await gitTracked(root);
  const found: Array<{ path: string; size: number }> = [];

  /*
    A level at a time, eight in flight.

    Asking the disk for one thing and waiting for the answer before asking
    for the next is most of what this cost: the same walk with eight lanes
    open is about four times quicker, and a ninth buys nothing. The order the
    answers arrive in does not matter because the list is sorted at the end.
  */
  let level = [root];
  while (level.length) {
    const next: string[] = [];
    let at = 0;
    const lane = async (): Promise<void> => {
      while (at < level.length) {
        const directory = level[at]!;
        at += 1;
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }
        const here: Array<{ full: string; relative: string }> = [];
        for (const entry of entries) {
          const full = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (isUncounted(entry.name)) continue;
          const relative = path.relative(root, full).split(path.sep).join("/");

          if (entry.isDirectory()) {
            if (
              excludes(relative, true, layers) &&
              !negationReachesInto(relative, layers) &&
              !tracked?.folders.has(relative)
            ) {
              continue;
            }
            next.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (excludes(relative, false, layers) && !tracked?.files.has(relative)) continue;
          here.push({ full, relative });
        }
        for (let from = 0; from < here.length; from += WALK_LANES) {
          const sized = await Promise.all(
            here.slice(from, from + WALK_LANES).map(async (one) => {
              try {
                return { path: one.relative, size: (await stat(one.full)).size };
              } catch {
                /* Gone or unreadable since the walk began; the upload says so. */
                return null;
              }
            }),
          );
          for (const one of sized) {
            if (!one) continue;
            found.push(one);
            if (onFound && found.length % 500 === 0) onFound(found.length);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WALK_LANES, level.length) }, () => lane()),
    );
    level = next;
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

export async function totalSize(root: string, files: ChangedFile[]): Promise<number> {
  let total = 0;
  /* Same reason as the walk: these are all waiting, so let them wait together. */
  for (let from = 0; from < files.length; from += WALK_LANES) {
    const sizes = await Promise.all(
      files.slice(from, from + WALK_LANES).map((file) =>
        stat(path.join(root, file.path)).then(
          (info) => info.size,
          /* deleted since the scan; it contributes nothing */
          () => 0,
        ),
      ),
    );
    for (const size of sizes) total += size;
  }
  return total;
}

/** The unified diff for one file, including files git does not track yet. */
export async function fileDiff(
  root: string,
  file: string,
  ignoreWhitespace = false,
): Promise<Hunk[]> {
  const output = await git(
    root,
    "diff",
    "--no-ext-diff",
    "--unified=3",
    ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
    "--",
    file,
  );
  /*
    What leaves this function is what the window will show, so a credential
    is covered here rather than in the pane.

    Masking in the renderer would still have sent the key to the window,
    where a screenshot, the developer tools or an accidental copy all reach
    it. Not sending it is the only version of this that actually holds.

    Two rules, because there are two kinds. A key pasted into ordinary source
    is recognised by its own format. A `.env` is not — its contents match no
    service's shape — and is recognised only by the name of the file, so
    everything after the first `=` on a line goes.
  */
  const named = isCredentialByName(file);
  const cover = (text: string): string =>
    named ? maskAssignedValues(text) : maskCredentials(text);

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of (output ?? "").split(/\r?\n/)) {
    if (raw.startsWith("@@")) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      continue;
    }
    if (!current) continue;
    if (/^(diff |index |--- |\+\+\+ )/.test(raw)) continue;
    if (raw.startsWith("+")) {
      current.lines.push({
        kind: "add",
        number: newLine++,
        oldNumber: null,
        text: cover(raw.slice(1)),
      });
    } else if (raw.startsWith("-")) {
      current.lines.push({
        kind: "del",
        number: oldLine,
        oldNumber: oldLine++,
        text: cover(raw.slice(1)),
      });
    } else if (raw.startsWith(" ")) {
      current.lines.push({
        kind: "ctx",
        number: newLine,
        oldNumber: oldLine,
        text: cover(raw.slice(1)),
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  if (hunks.length) return hunks;

  // Untracked files have no diff; show them as wholly added.
  try {
    const contents = await readFile(path.join(root, file));
    if (contents.subarray(0, 8192).includes(0)) {
      return [{ header: `Binary file added: ${file}`, lines: [] }];
    }
    const lines = contents.toString("utf8").split(/\r?\n/);
    return [
      {
        header: `@@ -0,0 +1,${lines.length} @@ ${file}`,
        lines: lines.slice(0, 10_000).map((text, index) => ({
          kind: "add" as const,
          number: index + 1,
          oldNumber: null,
          text: cover(text),
        })),
      },
    ];
  } catch {
    return [{ header: `No textual diff is available for ${file}`, lines: [] }];
  }
}

/**
 * The folder as a tree, so filtering can be done by ticking things rather
 * than by writing glob patterns. Sizes are rolled up, because the only way
 * to decide whether to keep a folder is to know what it costs.
 */
/**
 * The folder as a tree, built from one walk rather than another descent.
 *
 * It used to recurse the disk itself, in step with an evaluation doing the
 * same descent alongside it — two serial passes over a folder that on a real
 * Unity project holds 47,387 files. Now both are worked out from a single
 * concurrent walk, so the filter screen reads the disk once.
 */
export async function projectTree(
  root: string,
  limitOrWalked: number | Walked = EVALUATION_FILE_LIMIT,
): Promise<TreeNode> {
  const walked =
    typeof limitOrWalked === "number"
      ? await walkProject(root, { limit: limitOrWalked })
      : limitOrWalked;
  return treeFrom(walked);
}

/** Fold the walk into nodes, carrying sizes and counts up as it goes. */
export function treeFrom(walked: Walked): TreeNode {
  const root: TreeNode = {
    path: "",
    name: ".",
    directory: true,
    size: 0,
    files: 0,
    children: [],
    ...(walked.truncated ? { truncated: true } : {}),
  };
  const folders = new Map<string, TreeNode>([["", root]]);

  const folderAt = (relative: string): TreeNode => {
    const held = folders.get(relative);
    if (held) return held;
    const cut = relative.lastIndexOf("/");
    const parent = folderAt(cut < 0 ? "" : relative.slice(0, cut));
    const node: TreeNode = {
      path: relative,
      name: relative.slice(cut + 1),
      directory: true,
      size: 0,
      files: 0,
      children: [],
    };
    parent.children!.push(node);
    folders.set(relative, node);
    return node;
  };

  /* Empty folders are folders, and a tree that hides them is a different
     folder from the one on disk. */
  for (const directory of walked.directories) folderAt(directory);

  for (const file of walked.files) {
    const cut = file.path.lastIndexOf("/");
    const parent = folderAt(cut < 0 ? "" : file.path.slice(0, cut));
    parent.children!.push({
      path: file.path,
      name: file.path.slice(cut + 1),
      directory: false,
      size: file.size,
      files: 1,
    });
    /* Up the chain, so a folder can be judged without opening it. */
    for (let at: TreeNode | undefined = parent; at; ) {
      at.size += file.size;
      at.files += 1;
      const cutAt = at.path.lastIndexOf("/");
      at = at.path === "" ? undefined : folders.get(cutAt < 0 ? "" : at.path.slice(0, cutAt));
    }
  }

  // Folders first, then files, each alphabetically — the familiar order.
  for (const node of folders.values()) {
    node.children!.sort((left, right) =>
      left.directory === right.directory
        ? left.name.localeCompare(right.name)
        : left.directory
          ? -1
          : 1,
    );
  }
  return root;
}

export type EvaluateOptions = {
  shouldStop?: () => boolean;
  limit?: number;
  /** A walk already done, so the same folder is not read twice over. */
  walked?: Walked;
};

/**
 * Every file under a folder, with its size, walked eight at a time.
 *
 * The filter screen used to walk the same folder twice over, once to build
 * the tree and once to apply the rules, and both walks asked the disk for one
 * thing at a time. On a 47,387-file Unity project that is 47,387 serial stat
 * calls, and a stat is almost entirely waiting: the same walk with eight in
 * flight is 2,483ms down to 638ms, and more lanes than eight buy nothing.
 *
 * So there is one walk, it is concurrent, and the tree and the evaluation are
 * both worked out from what it returns rather than from the disk.
 */
const WALK_LANES = 8;

export type WalkedFile = { path: string; size: number };
export type Walked = {
  files: WalkedFile[];
  /** Directories, so one holding nothing still appears in the tree. */
  directories: string[];
  truncated: boolean;
};

export async function walkProject(
  root: string,
  options: EvaluateOptions = {},
): Promise<Walked> {
  const limit = options.limit ?? EVALUATION_FILE_LIMIT;
  const files: WalkedFile[] = [];
  const directories: string[] = [];
  let truncated = false;
  let stopped = false;

  /* Breadth-first, a level at a time, so the lanes always have work. */
  let level = [root];
  while (level.length && !stopped) {
    const next: string[] = [];
    let at = 0;
    const lane = async (): Promise<void> => {
      while (at < level.length) {
        if (stopped) return;
        const directory = level[at]!;
        at += 1;
        if (options.shouldStop?.()) {
          stopped = true;
          return;
        }
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }
        const here: string[] = [];
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          if (isUncounted(entry.name)) continue;
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            next.push(full);
            directories.push(relativeTo(root, full));
            continue;
          }
          if (entry.isFile()) here.push(full);
        }
        for (let from = 0; from < here.length; from += WALK_LANES) {
          const sized = await Promise.all(
            here.slice(from, from + WALK_LANES).map(async (full) => {
              try {
                return { full, size: (await stat(full)).size };
              } catch {
                return null;
              }
            }),
          );
          for (const one of sized) {
            if (!one) continue;
            if (files.length >= limit) {
              truncated = true;
              stopped = true;
              return;
            }
            files.push({ path: relativeTo(root, one.full), size: one.size });
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WALK_LANES, level.length) }, () => lane()),
    );
    level = next;
  }

  return { files, directories, truncated };
}

/** A path under the root, written the way the rules are. */
function relativeTo(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/");
}

/**
 * Measure what the supplied rules would upload, skip and force-keep.
 *
 * This deliberately walks into ignored directories, because the filtering
 * screen has to be able to say what each rule costs before it is accepted.
 */
export async function evaluateRules(
  root: string,
  rules: FilterRules,
  options: EvaluateOptions = {},
): Promise<RuleEvaluation> {
  const layers = await collectLayers(root, rules);
  const tracked = await gitTracked(root);
  const impactBytes = new Map<string, number>();
  const impactFiles = new Map<string, number>();
  const excluded: ExcludedItem[] = [];

  let uploadFiles = 0;
  let uploadBytes = 0;
  let skippedFiles = 0;
  let skippedBytes = 0;
  let keptFiles = 0;
  let keptBytes = 0;

  const walked = options.walked ?? (await walkProject(root, options));
  if (options.shouldStop?.()) return emptyEvaluation(true);
  const truncated = walked.truncated;
  /* Kept for this evaluation only, so no edit to the rules can outlive it. */
  const folderAnswers: FolderAnswers = new Map();

  for (const file of walked.files) {
    const { path: relative, size } = file;

    // The last rule to speak wins, across every .gitignore that governs
    // this path. A `!` rule brings the file back and is worth reporting,
    // because it is how "always include" is expressed.
    /*
      The directories above it count. Asking `decide` about the file alone
      is what made this screen report a Unity project's whole Library as
      going up: `/[Ll]ibrary/` speaks about the directory, so no rule
      matched the file and every one of them looked included — while the
      save, which has always walked the ancestors, left them all behind.
    */
    const rule = decidingRule(relative, false, layers, folderAnswers);
    if (rule?.negated) {
      keptFiles += 1;
      keptBytes += size;
      uploadFiles += 1;
      uploadBytes += size;
      excluded.push({
        path: relative,
        bytes: size,
        rule: `!${rule.pattern}`,
        forceKept: true,
      });
      continue;
    }
    if (rule && tracked?.files.has(relative)) {
      /*
        A rule matches it, and git tracks it, so it goes up regardless — and
        is listed with what kept it, beside the files a `!` rule keeps.
      */
      keptFiles += 1;
      keptBytes += size;
      uploadFiles += 1;
      uploadBytes += size;
      excluded.push({ path: relative, bytes: size, rule: TRACKED_BY_GIT, forceKept: true });
      continue;
    }
    if (rule) {
      skippedFiles += 1;
      skippedBytes += size;
      impactBytes.set(rule.pattern, (impactBytes.get(rule.pattern) ?? 0) + size);
      impactFiles.set(rule.pattern, (impactFiles.get(rule.pattern) ?? 0) + 1);
      excluded.push({
        path: relative,
        bytes: size,
        rule: rule.pattern,
        forceKept: false,
      });
      continue;
    }
    uploadFiles += 1;
    uploadBytes += size;
  }

  /*
    Sorted, and all of it.

    This used to hand back the four hundred largest, which was right for a
    flat list somebody scrolls and wrong for what reads it now: the screen
    folds these into folders, so a Unity project's Library — 45,739 files —
    was drawn from four hundred of them and labelled "395 files" beside a
    header that said 45,739. The grouping happens here, in this process, and
    only the folded tree crosses to the window, so keeping all of them costs
    an array nobody sends.
  */
  excluded.sort((left, right) => right.bytes - left.bytes);
  const impacts = [...impactBytes.entries()]
    .map(([pattern, bytes]) => ({
      pattern,
      bytes,
      files: impactFiles.get(pattern) ?? 0,
    }))
    .sort((left, right) => right.bytes - left.bytes);

  return {
    uploadFiles,
    uploadBytes,
    skippedFiles,
    skippedBytes,
    keptFiles,
    keptBytes,
    impacts,
    excluded,
    truncated,
  };
}

function emptyEvaluation(truncated: boolean): RuleEvaluation {
  return {
    uploadFiles: 0,
    uploadBytes: 0,
    skippedFiles: 0,
    skippedBytes: 0,
    keptFiles: 0,
    keptBytes: 0,
    impacts: [],
    excluded: [],
    truncated,
  };
}

/*
  Names that are a credential whatever is inside them.

  The first three were the whole list, which meant the check answered for a
  hand-written `.env` and for nothing a tool leaves behind. Every addition
  below is something a program writes without being asked: a cloud CLI's
  cached login, an SSH key, a registry token. Those are the ones that get
  published, precisely because nobody chose to put them there.
*/
const SECRET_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".dockercfg",
  ".pypirc",
  "credentials",
  "credentials.json",
  "wrangler-account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];

/*
  Directories that are one program's private state, not somebody's project.

  These are judged by directory rather than by file because that is how they
  arrive: nobody adds `Local Storage/leveldb/000005.ldb`, they add a folder
  and everything under it comes too. Matching the folder is also what lets
  the answer be a rule — one line in .gitignore covers the lot, where a list
  of the files inside it would go stale the moment the program ran again.
*/
const PRIVATE_DIRECTORIES: Array<{ match: RegExp; because: string }> = [
  {
    match: /^(Local Storage|Session Storage|IndexedDB|Service Worker|Cache|Code Cache|GPUCache)$/i,
    because: "a browser profile, which holds the sites you are signed in to",
  },
  { match: /^\.wrangler$/i, because: "local service state, including emulated databases" },
  { match: /^\.aws$/i, because: "cloud credentials" },
  { match: /^\.ssh$/i, because: "SSH keys" },
  { match: /^\.gnupg$/i, because: "signing keys" },
  { match: /^\.docker$/i, because: "registry logins" },
  { match: /^\.terraform$/i, because: "infrastructure state" },
  /*
    Not private in itself, and included for a reason worth stating: the
    credential check refuses to walk it, sensibly, because it is enormous and
    none of it is yours. That makes it the one place a cached login can sit
    and never be found by name — which is exactly where a real one was, at
    `node_modules/.cache/wrangler/wrangler-account.json`. Naming the folder
    covers everything the name check cannot reach into.
  */
  {
    match: /^node_modules$/i,
    because:
      "a dependency folder, which is rebuilt from your manifest and is where tools cache their logins",
  },
];

/** What a private directory is, and the rule that would leave it behind. */
export type PrivateFinding = {
  /** The directory, relative to the project root. */
  path: string;
  /** Why it should not be published, in words somebody can act on. */
  because: string;
  /** A .gitignore line that covers it. */
  rule: string;
};

/**
 * Folders in this project that belong to a program rather than to the work.
 *
 * Deliberately separate from `detectSecrets`. A credential is a refusal: it
 * must not be published and the answer is to remove it. One of these is a
 * question — the files are not dangerous in themselves, they are simply not
 * the project, and the useful response is a rule rather than a refusal.
 */
export async function detectPrivateDirectories(
  root: string,
): Promise<PrivateFinding[]> {
  const found: PrivateFinding[] = [];
  const pending: string[] = [root];
  let seen = 0;
  while (pending.length && found.length < 25 && seen < 40_000) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (!entry.isDirectory()) continue;
      if (isUncounted(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      const rule = PRIVATE_DIRECTORIES.find((candidate) =>
        candidate.match.test(entry.name),
      );
      if (rule) {
        found.push({
          path: relative,
          because: rule.because,
          rule: `${relative}/`,
        });
        /* No need to walk into it; the whole folder is the answer. */
        continue;
      }
      pending.push(full);
    }
  }
  return found;
}

/** A credential found inside an ordinary file, and where. */
export type PastedFinding = {
  /** The file, relative to the project root. */
  path: string;
  /** Which credentials are in it, without quoting any of them. */
  found: CredentialFinding[];
};

/**
 * How much of the selection the content scan actually read.
 *
 * The scan stops at twenty thousand files and two hundred and fifty-six
 * megabytes, and it used to stop in silence — so a Unity project of
 * forty-seven thousand files had twenty-seven thousand of them never opened
 * while the screen showed a clean result. A check that quietly covers half of
 * what it appears to cover is worse than one that admits its limit, because
 * the first is believed.
 */
export type ScanReach = {
  /** Files opened and read. */
  scanned: number;
  /** Files it was asked to read. */
  of: number;
  /** False when a bound stopped it before the end. */
  complete: boolean;
};

/** What a check found in a selection, and nothing about what to do next. */
export type UploadConcerns = {
  /** Files that are a credential by name. */
  secrets: string[];
  /** Folders that belong to a program rather than to the work. */
  shielded: PrivateFinding[];
  /*
    Credentials pasted into files that are not credentials.

    Separate from `secrets` because the answer is different. A `.env` should
    not be published and the fix is to leave it out; a key inside `config.py`
    means the file goes up either way and the key has to come out of it — and
    if it was ever pushed anywhere, be rotated.
  */
  pasted: PastedFinding[];
  /** How far the content scan got, so the UI can say so rather than imply. */
  reach: ScanReach;
};

/**
 * Whether a selection should be questioned before it is sent.
 *
 * Lifted out of the window's message handler so it can be exercised without
 * starting one. The desktop is the path a real leak took, and a rule that
 * only runs inside a GUI is a rule nobody can prove: this returns the two
 * lists and takes no view, leaving the refusing to the caller that has a
 * person to ask.
 *
 * Narrowed to the selection on purpose. A folder the rules already leave
 * behind is not being published, and raising it would train people to dismiss
 * the question that matters.
 */
/*
  Bounds for the content scan, stated rather than discovered.

  This reads files, which the name check never did, so it is the one check
  whose cost grows with the project. A person waiting to publish will not wait
  long, and a scan they turn off protects nobody — so it reads what it can
  inside these limits and is honest about stopping.
*/
const MOST_SCANNED_FILES = 20_000;
const MOST_SCANNED_BYTES = 256 * 1024 * 1024;
/** Past this a file is data, not something somebody pasted a key into. */
const MOST_FILE_BYTES = 2 * 1024 * 1024;
/** Enough to make the point; a list of five hundred is not read. */
const MOST_FINDINGS = 40;

/**
 * Credentials sitting inside files that are not credentials.
 *
 * The name check finds the files a tool wrote — `.env`, a cached login, an
 * SSH key. This finds the other kind, and it is the kind nothing caught: a
 * key pasted into `settings.py` while getting something working, in a file
 * with an ordinary name that every check waved through.
 *
 * Narrowed to the selection, like the rest of the concerns: a file the rules
 * already leave behind is not being published, and raising it would train
 * people to dismiss the question that matters.
 */
export async function detectPastedCredentials(
  root: string,
  include: readonly string[],
  /*
    Told how many have been looked at, every so often.

    This reads up to twenty thousand files before a save begins, and it did so
    one after another with nothing reported — on Windows, where every open is
    also an antivirus scan, that is a quarter of an hour in which the panel
    could only show the words "Working out what to send" and no number at all.
    The same silence the read stage used to have, in a different module.
  */
  onScanned?: (scanned: number, of: number) => void,
): Promise<{ found: PastedFinding[]; reach: ScanReach }> {
  const found: PastedFinding[] = [];
  let read = 0;
  let bytes = 0;
  /*
    Read several at a time. This is waiting on the disk, not computing, so
    overlapping the waits collapses them into one wait — the same change the
    hashing stage needed, for the same reason.
  */
  const LANES = 8;
  const wanted = include.filter((relative) =>
    worthReading(relative.slice(relative.lastIndexOf("/") + 1)),
  );
  let cursor = 0;
  let stop = false;
  const lane = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const at = cursor;
      cursor += 1;
      if (at >= wanted.length) return;
      if (found.length >= MOST_FINDINGS) { stop = true; return; }
      if (read >= MOST_SCANNED_FILES || bytes >= MOST_SCANNED_BYTES) {
        stop = true;
        return;
      }
      const relative = wanted[at]!;
      const full = path.join(root, relative.split("/").join(path.sep));
      let contents: Buffer;
      try {
        const info = await stat(full);
        if (!info.isFile() || info.size > MOST_FILE_BYTES) continue;
        contents = await readFile(full);
      } catch {
        /* Unreadable is the scan's problem, not something to report as clean. */
        continue;
      }
      read += 1;
      bytes += contents.byteLength;
      if (onScanned && read % 50 === 0) onScanned(read, wanted.length);
      if (!looksLikeText(contents)) continue;
      const credentials = findCredentials(contents.toString("utf8"));
      if (credentials.length) found.push({ path: relative, found: credentials });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LANES, wanted.length) }, () => lane()),
  );
  /*
    `stop` is also set by the findings ceiling, which is a different statement
    from running out of budget — forty findings is plenty to act on, and the
    files after it are very likely more of the same. Only a bound on the
    reading makes the scan incomplete in a way worth saying out loud.
  */
  const spent = read >= MOST_SCANNED_FILES || bytes >= MOST_SCANNED_BYTES;
  return {
    found,
    reach: { scanned: read, of: wanted.length, complete: !spent },
  };
}

export async function uploadConcerns(
  root: string,
  include: readonly string[],
  /** Passed through so the one slow part of this can say it is working. */
  onScanned?: (scanned: number, of: number) => void,
): Promise<UploadConcerns> {
  const chosen = new Set(include);
  const [named, folders, pasted] = await Promise.all([
    detectSecrets(root),
    detectPrivateDirectories(root),
    detectPastedCredentials(root, include, onScanned),
  ]);
  const secrets = named.filter((file) => chosen.has(file));
  return {
    secrets,
    shielded: folders.filter((finding) =>
      [...chosen].some(
        (file) => file === finding.path || file.startsWith(`${finding.path}/`),
      ),
    ),
    /*
      A file already refused by name is not raised twice. Saying "this is a
      credential" and "there is a credential inside it" about the same file
      is two warnings for one problem, and the first one is the actionable
      one.
    */
    pasted: pasted.found.filter((finding) => !secrets.includes(finding.path)),
    reach: pasted.reach,
  };
}

/** Files the flow must ask about before the first upload. */
/**
 * Whether this path is a credential by its name alone.
 *
 * Pulled out of `detectSecrets` so the diff can ask the same question the
 * upload warning asks. A `.env` holds `TOKEN=<32 random characters>`, which
 * matches no service's format and so is invisible to the pattern scan — the
 * only thing that identifies it is the name of the file it is sitting in.
 */
/**
 * The `.env.<something>` files that exist to be committed.
 *
 * `.env.example` is the file a project is *supposed* to publish — it is the
 * documentation of which variables exist, with the values left empty. Refusing
 * to send it, and then advising it be added to .gitignore, is advice that
 * breaks the project for the next person who clones it.
 *
 * The same list the service uses when it decides what to cover, so a file is
 * not a template in one half of the system and a credential in the other.
 */
const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"];

function isTemplateName(name: string): boolean {
  return TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function isCredentialByName(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (isTemplateName(name)) return false;
  return (
    SECRET_NAMES.has(name) ||
    name.startsWith(".env.") ||
    SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    parts.slice(0, -1).includes("secrets")
  );
}

export async function detectSecrets(root: string): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  let enough = false;

  /*
    Every directory, eight at a time. This reads names and nothing else, so
    it is pure waiting, and it was waiting one directory at a time over all
    two and a half thousand of them on a real project.

    It still looks everywhere the rules do not. A credential inside a folder
    that is currently ignored is one rule edit away from being sent, and this
    is the check that is supposed to notice before that happens.
  */
  let level = [root];
  while (level.length && !enough) {
    const next: string[] = [];
    let at = 0;
    const lane = async (): Promise<void> => {
      while (at < level.length && !enough) {
        const directory = level[at]!;
        at += 1;
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (found.length >= 50 || seen > 40_000) {
            enough = true;
            return;
          }
          const full = path.join(directory, entry.name);
          if (isUncounted(entry.name)) continue;
          if (entry.isDirectory()) {
            if (entry.name !== "node_modules") next.push(full);
            continue;
          }
          seen += 1;
          /*
            Asked of the one function rather than repeated here. These were
            two copies of the same rule, which is how `.env.example` came to
            be refused by the command line long after the service had learned
            that templates are not credentials.
          */
          const relative = path.relative(root, full).split(path.sep).join("/");
          if (isCredentialByName(relative)) found.push(relative);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WALK_LANES, level.length) }, () => lane()),
    );
    level = next;
  }
  return found;
}
