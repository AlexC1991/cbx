/**
 * `cbx pages`: a public project served as a website.
 *
 * Kept in its own file beside the other project commands. It is one command
 * with four answers — what the site is set to, find the build for me, on, off
 * — and the "find it for me" answer reaches onto the disk and into the ignore
 * rules, which none of the account-side commands do.
 *
 * Turning a site on is the step that asks. What it serves is the project's
 * own code, running in a stranger's browser under the project's name, and
 * that deserves a yes from somebody who can give one. Turning it off asks
 * nothing: it takes nothing from anybody who should have it.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  autoPages,
  detectPages,
  pages,
  setPages,
  ServiceError,
  versions,
  type AccountProject,
  type PagesChange,
  type PagesKind,
  type PagesSettings,
} from "./api.js";
import { readLink } from "./config.js";
import { agreed, resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";
import {
  collectLayers,
  gitTracked,
  readRules,
  writeRules,
} from "../../cbx/src/core/worktree.js";
import {
  decidingRule,
  excludes,
  isUncounted,
  type Rule,
  type RuleLayer,
} from "../../cbx/src/core/rules.js";
import type { FilterRules } from "../../cbx/src/shared/types.js";

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (text: string) => (colour ? `[2m${text}[0m` : text);
const bold = (text: string) => (colour ? `[1m${text}[0m` : text);
const accent = (text: string) => (colour ? `[33m${text}[0m` : text);
const red = (text: string) => (colour ? `[31m${text}[0m` : text);
const green = (text: string) => (colour ? `[32m${text}[0m` : text);

const SUBCOMMANDS = new Set(["status", "auto", "on", "off"]);

/** `[action] [project]`, where the action is recognised by being one. */
export function splitPages(positional: string[]): {
  action: "status" | "auto" | "on" | "off";
  project?: string;
} {
  const [first, second] = positional;
  if (first && SUBCOMMANDS.has(first.toLowerCase())) {
    return {
      action: first.toLowerCase() as "status" | "auto" | "on" | "off",
      project: second,
    };
  }
  return { action: "status", project: first };
}

/** What a kind of build is called when it is said out loud. */
const KIND_WORDS: Record<PagesKind, string> = {
  unity: "a Unity WebGL build",
  godot: "a Godot web export",
  vite: "a Vite build",
  next: "a Next.js static export",
  react: "a React build",
  static: "a website",
};

export const kindWords = (kind: string) =>
  KIND_WORDS[kind as PagesKind] ?? "a website";

/** "in dist/", or "at the top of the project" for the empty folder. */
export const whereWords = (folder: string) =>
  folder ? `in ${folder.replace(/\/+$/, "")}/` : "at the top of the project";

/**
 * A folder as the service wants it: forward slashes, no leading `./`, no
 * trailing slash, and "" for the top. Typed on Windows it arrives with
 * backslashes, and `.` is how people say "right here".
 */
export function normaliseFolder(typed: string): string {
  const cleaned = typed
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return cleaned === "." ? "" : cleaned;
}

/** A switch given as `--spa`, `--spa=off` or `--no-spa`. */
function switchValue(parsed: Parsed, ...names: string[]): boolean | undefined {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (value !== undefined) {
      if (value === true) return true;
      return !["off", "false", "no", "n", "0"].includes(value.trim().toLowerCase());
    }
    if (parsed.flags.get(`no-${name}`) !== undefined) return false;
  }
  return undefined;
}

const sure = (parsed: Parsed) =>
  parsed.flags.get("yes") === true || parsed.flags.get("y") === true;

/**
 * Say a refusal in a way somebody can act on.
 *
 * The service's own sentence is passed on as it is — it knows why — with a
 * line after it where there is an obvious next command. Two are recognised
 * by status rather than wording: "this service has no Pages yet", which is
 * not the person's fault and not something they can fix, and "only the owner
 * can", which the service says in its own words.
 */
export function explainRefusal(error: unknown, projectRef: string): string[] {
  if (error instanceof ServiceError) {
    if (
      error.status === 503 ||
      error.code === "pages_not_ready" ||
      (error.status === 404 && error.code === "not_found")
    ) {
      return ["Pages is not available on this service yet."];
    }
    if (error.status === 403) {
      return [
        error.message ||
          "Access denied: only the project's owner or an admin can change its site.",
      ];
    }
    const lines = [error.message];
    if (error.code === "pages_needs_public") {
      lines.push(dim(`  Make the project public first: cbx visibility public${projectRef}`));
    } else if (error.code === "version_not_public") {
      lines.push(dim("  Only a published version can be served. cbx promote publishes a save."));
    }
    return lines;
  }
  return [error instanceof Error ? error.message : String(error)];
}

function refuse(error: unknown, projectRef: string): number {
  for (const line of explainRefusal(error, projectRef)) console.error(red(line));
  return 1;
}

/** The settings, laid out the way somebody checks them. */
function printSettings(project: AccountProject, settings: PagesSettings): void {
  const label = (text: string) => `  ${text.padEnd(9)} `;
  console.log(
    `${bold(project.name)} — Pages is ${settings.enabled ? green("on") : dim("off")}`,
  );
  console.log(
    label("Address") +
      (settings.address
        ? settings.address
        : dim("goes live when the Pages domain is set up")),
  );
  if (settings.live) {
    const name = settings.live.name ? ` ${bold(settings.live.name)}` : "";
    const which = settings.versionId ? "pinned" : "newest published";
    /* While off it is what would be served, so it is not called "Serving". */
    console.log(
      label(settings.enabled ? "Serving" : "Would serve") +
        `${accent(`v${settings.live.sequence}`)}${name}  ${dim(which)}`,
    );
  } else {
    console.log(label("Serving") + dim("nothing published yet"));
  }
  console.log(
    label("Folder") +
      (settings.folder ? `${settings.folder}/` : "top of the project") +
      (settings.entry ? dim(`  (${settings.entry.path})`) : ""),
  );
  console.log(
    label("Options") +
      `single-page app ${settings.spa ? "yes" : "no"}` +
      dim(" · ") +
      `cross-origin isolation ${settings.isolation ? "yes" : "no"}`,
  );
  if (settings.entry && !settings.entry.found) {
    console.log(
      accent(
        `  Warning: ${settings.entry.path} is not in ` +
          (settings.live ? `v${settings.live.sequence}` : "the published files") +
          ", so the site has no front page.",
      ),
    );
  }
  if (settings.blocked) console.log(label("Blocked") + red(settings.blocked));
}

/** Pages settings for a project, or null after saying why not. */
async function current(project: AccountProject, projectRef: string) {
  try {
    return await pages(project.id);
  } catch (error) {
    refuse(error, projectRef);
    return null;
  }
}

/**
 * Show, find, switch on or switch off a project's site.
 */
export async function commandPages(parsed: Parsed): Promise<number> {
  const { action, project: reference } = splitPages(parsed.positional);
  const project = await resolveProject(reference);
  if (!project) return 1;
  const projectRef = reference ? ` ${reference}` : "";

  if (action === "status") {
    const settings = await current(project, projectRef);
    if (!settings) return 1;
    printSettings(project, settings);
    if (!settings.enabled) {
      console.log("");
      console.log(dim(`Turn it on: cbx pages auto${projectRef}   finds the build for you`));
      console.log(dim(`        or: cbx pages on${projectRef} --folder <path>`));
    }
    return 0;
  }

  if (action === "off") {
    try {
      const settings = await setPages(project.id, { enabled: false });
      console.log(green(`Pages is off for ${project.name}.`));
      if (settings.address) console.log(dim(`  ${settings.address} no longer serves anything.`));
      return 0;
    } catch (error) {
      return refuse(error, projectRef);
    }
  }

  if (action === "on") return turnOn(parsed, project, projectRef);
  return auto(parsed, project, projectRef);
}

/** Refused rather than asked when nobody can answer; see commandVisibility. */
function nobodyToAsk(what: string): number {
  console.error(red(`${what} needs a yes, and nobody is here to give one.`));
  console.error(dim("  Run it in a terminal to be asked, or add --yes."));
  return 1;
}

/** Said before the question, so the yes is to something specific. */
function sayWhatGoesPublic(project: AccountProject, address: string | null): void {
  console.log(
    `Pages serves ${bold(project.name)}'s published files as a website` +
      (address ? ` at ${address}` : "") +
      ".",
  );
  console.log(
    "  Anybody can open it, and the code in it runs in their browser under the project's name.",
  );
  if (!address) console.log(dim("  It goes live when the Pages domain is set up."));
}

function notPublic(project: AccountProject, projectRef: string): number | null {
  if (project.visibility === "public") return null;
  console.error(red(`${project.name} is not public, and only a public project can have a site.`));
  console.error(dim(`  Make it public first: cbx visibility public${projectRef}`));
  return 1;
}

/** `--version 12`, `--version <id>` or `--version newest`. */
async function versionFor(
  project: AccountProject,
  typed: string,
): Promise<{ versionId: string | null } | { error: string }> {
  const text = typed.trim().replace(/^v(?=\d+$)/i, "");
  if (["newest", "latest"].includes(text.toLowerCase())) return { versionId: null };
  if (/^\d+$/.test(text)) {
    const saved = await versions(project.id);
    const found = saved.find((one) => one.sequence === Number(text));
    if (!found) return { error: `${project.name} has no v${text}.` };
    return { versionId: found.id };
  }
  return { versionId: text };
}

async function turnOn(
  parsed: Parsed,
  project: AccountProject,
  projectRef: string,
): Promise<number> {
  const change: PagesChange = { enabled: true };
  const folder = parsed.flags.get("folder");
  if (folder === true) {
    console.error(red("--folder needs a path, such as --folder dist. Use --folder . for the top."));
    return 1;
  }
  if (typeof folder === "string") change.folder = normaliseFolder(folder);
  const spa = switchValue(parsed, "spa");
  if (spa !== undefined) change.spa = spa;
  const isolation = switchValue(parsed, "isolate", "isolation");
  if (isolation !== undefined) change.isolation = isolation;
  const version = parsed.flags.get("version");
  if (version === true) {
    console.error(red("--version needs a number, an id, or newest."));
    return 1;
  }
  if (typeof version === "string") {
    const found = await versionFor(project, version);
    if ("error" in found) {
      console.error(red(found.error));
      return 1;
    }
    change.versionId = found.versionId;
  }

  const refused = notPublic(project, projectRef);
  if (refused !== null) return refused;

  const before = await current(project, projectRef);
  if (!before) return 1;

  /*
    Asked only when the site is off. Moving a site that is already public to
    another folder or version changes what it shows, not whether it exists,
    and that decision has already been made by somebody who could make it.
  */
  if (!before.enabled && !sure(parsed)) {
    if (!process.stdin.isTTY) return nobodyToAsk(`Turning on Pages for ${project.name}`);
    sayWhatGoesPublic(project, before.address);
    if (!(await agreed(`Turn on Pages for ${project.name}? [y/N] `))) {
      console.log(dim(`Nothing changed. Pages is still off for ${project.name}.`));
      return 1;
    }
  }

  let settings: PagesSettings;
  try {
    settings = await setPages(project.id, change);
  } catch (error) {
    return refuse(error, projectRef);
  }
  console.log(
    green(before.enabled ? `Pages settings changed for ${project.name}.` : `Pages is on for ${project.name}.`),
  );
  console.log("");
  printSettings(project, settings);
  return 0;
}

async function auto(
  parsed: Parsed,
  project: AccountProject,
  projectRef: string,
): Promise<number> {
  let found;
  try {
    found = await detectPages(project.id);
  } catch (error) {
    return refuse(error, projectRef);
  }

  if (found.suggestion) {
    const suggestion = found.suggestion;
    const where = whereWords(suggestion.folder);
    const inVersion = found.version ? ` of v${found.version.sequence}` : "";
    console.log(`Found ${kindWords(suggestion.kind)} ${where}${inVersion}.`);
    if (suggestion.why) console.log(dim(`  ${suggestion.why}`));
    const extras = [
      suggestion.spa ? "as a single-page app" : "",
      suggestion.isolation ? "with cross-origin isolation" : "",
    ].filter(Boolean);
    if (extras.length) console.log(dim(`  It would be served ${extras.join(", ")}.`));

    const refused = notPublic(project, projectRef);
    if (refused !== null) return refused;

    if (!sure(parsed)) {
      if (!process.stdin.isTTY) return nobodyToAsk(`Turning on Pages for ${project.name}`);
      const before = await pages(project.id).catch(() => null);
      sayWhatGoesPublic(project, before?.address ?? null);
      if (!(await agreed(`Turn on Pages for ${project.name} with this? [y/N] `))) {
        console.log(dim("Nothing changed."));
        return 1;
      }
    }

    let settings;
    try {
      settings = await autoPages(project.id);
    } catch (error) {
      return refuse(error, projectRef);
    }
    console.log(green(`Pages is on for ${project.name}.`));
    console.log("");
    printSettings(project, settings);
    return 0;
  }

  /*
    Nothing to serve in what was published. If this is the project's own
    folder, the build may be sitting right here and simply never have gone
    up — most often because the ignore rules leave build output out, which
    is exactly right for a repository and exactly wrong for a site.
  */
  const root = process.cwd();
  const link = await readLink(root).catch(() => null);
  if (link?.repositoryId === project.id) {
    const builds = await findWebBuilds(root);
    if (builds.length) return offerLocalBuild(parsed, root, builds, projectRef);
  }

  console.log(found.problem ?? "Nothing in the published files looks like a website.");
  return 1;
}

// ── the build on the disk ───────────────────────────────────────────────────

/** Where build tools put a site, in roughly the order they are met. */
export const BUILD_FOLDERS = [
  "dist",
  "build",
  "out",
  "public",
  "docs",
  "Build",
  "WebGL",
  "web",
  "html5",
  "export",
  "site",
  "_site",
  "www",
];

export type LocalBuild = { folder: string; kind: "unity" | "godot" | "static" };

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function namesIn(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Unity's loader beside a Build folder, or Godot's pack beside the page. */
async function kindOf(directory: string): Promise<LocalBuild["kind"]> {
  for (const entry of await namesIn(path.join(directory, "Build"))) {
    if (entry.isFile() && entry.name.endsWith(".loader.js")) return "unity";
  }
  for (const entry of await namesIn(directory)) {
    if (entry.isFile() && entry.name.endsWith(".pck")) return "godot";
  }
  return "static";
}

/**
 * Folders here holding an index.html, engine builds first.
 *
 * The usual build folders, one level inside them (`Build/WebGL`,
 * `export/web`), and any other top-level folder only when an engine's marker
 * says it is a build — a stray index.html in `templates/` is not a site.
 */
export async function findWebBuilds(root: string): Promise<LocalBuild[]> {
  const found: LocalBuild[] = [];
  const seen = new Set<string>();
  const consider = async (folder: string, needMarker: boolean) => {
    const key = folder.toLowerCase();
    if (seen.has(key)) return;
    const directory = path.join(root, ...folder.split("/"));
    if (!(await isFile(path.join(directory, "index.html")))) return;
    const kind = await kindOf(directory);
    if (needMarker && kind === "static") return;
    seen.add(key);
    found.push({ folder, kind });
  };

  const top = (await namesIn(root)).filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !isUncounted(entry.name) &&
      entry.name !== "node_modules",
  );
  const usual = new Set(BUILD_FOLDERS.map((name) => name.toLowerCase()));
  const ordered = [...top].sort(
    (left, right) =>
      rank(left.name) - rank(right.name) || left.name.localeCompare(right.name),
  );
  function rank(name: string) {
    const at = BUILD_FOLDERS.findIndex((one) => one.toLowerCase() === name.toLowerCase());
    return at === -1 ? BUILD_FOLDERS.length : at;
  }

  for (const entry of ordered) {
    if (!usual.has(entry.name.toLowerCase())) continue;
    await consider(entry.name, false);
    for (const inner of await namesIn(path.join(root, entry.name))) {
      if (inner.isDirectory() && !inner.name.startsWith(".")) {
        await consider(`${entry.name}/${inner.name}`, false);
      }
    }
  }
  for (const entry of ordered) {
    if (usual.has(entry.name.toLowerCase())) continue;
    await consider(entry.name, true);
  }
  /* An engine's build is a surer answer than a folder that happens to be
     called dist, so it goes first; otherwise the usual order stands. */
  return found.sort(
    (left, right) => Number(left.kind === "static") - Number(right.kind === "static"),
  );
}

/** Characters a gitignore pattern would read as syntax, written as themselves. */
const literal = (name: string) => name.replace(/[\\[\]*?!#]/g, "\\$&");

/** Which file a rule came from, for saying so. */
function sourceOf(rule: Rule, layers: RuleLayer[], rules: FilterRules): string {
  const layer = layers.find((one) => one.rules.includes(rule));
  if (!layer) return ".gitignore";
  if (layer.base) return `${layer.base}/.gitignore`;
  /* The personal layer, when there is one, is always first. */
  if (rules.local.trim() && layers[0] === layer) return ".git/info/exclude";
  return ".gitignore";
}

const written = (rule: Rule) =>
  `${rule.negated ? "!" : ""}${rule.anchored ? "/" : ""}${rule.pattern}${rule.directoryOnly ? "/" : ""}`;

export type Reinclusion =
  | { excluded: false }
  | {
      excluded: true;
      /** The line that leaves it out, and the file it is in. */
      rule: string;
      source: string;
      /** What to add to the project's .gitignore, or null when that cannot work. */
      lines: string[] | null;
      /** What stops the lines working, when they cannot. */
      obstacle?: string;
    };

/**
 * Whether the ignore rules leave a build's front page out, and what would
 * bring it back.
 *
 * Asked of the same rules, the same layers and the same matcher a save
 * uses, so the answer is the one `cbx submit` will act on. The fix is
 * checked the same way before it is offered: git cannot re-include a file
 * whose folder is excluded, so each excluded folder on the way down gets
 * its own negation, and a rule in a deeper .gitignore — which outranks the
 * project's own — is named rather than argued with.
 */
export async function reinclusionFor(
  root: string,
  folder: string,
  rules: FilterRules,
): Promise<Reinclusion> {
  const entry = folder ? `${folder}/index.html` : "index.html";
  const tracked = await gitTracked(root);
  if (tracked?.files.has(entry)) return { excluded: false };

  const layers = await collectLayers(root, rules);
  const deciding = decidingRule(entry, false, layers);
  if (!deciding || deciding.negated) return { excluded: false };
  const first = { rule: written(deciding), source: sourceOf(deciding, layers, rules) };

  const lines: string[] = [];
  const parts = folder ? folder.split("/") : [];
  for (let attempt = 0; attempt <= parts.length + 1; attempt += 1) {
    const shared = withLines(rules.shared, lines);
    const trial = await collectLayers(root, { ...rules, shared });
    const rule = decidingRule(entry, false, trial);
    if (!rule || rule.negated) return { excluded: true, ...first, lines };
    const source = sourceOf(rule, trial, { ...rules, shared });
    if (source !== ".gitignore" && source !== ".git/info/exclude") {
      return {
        excluded: true,
        ...first,
        lines: null,
        obstacle: `${source} has "${written(rule)}", and a deeper .gitignore outranks the project's own. Change or remove that line there.`,
      };
    }
    /* The outermost folder still left out, or the page itself. */
    let next: string | null = null;
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join("/");
      if (excludes(ancestor, true, trial)) {
        next = `!/${parts.slice(0, depth).map(literal).join("/")}/`;
        break;
      }
    }
    next ??= `!/${[...parts, "index.html"].map(literal).join("/")}`;
    if (lines.includes(next)) break;
    lines.push(next);
  }
  return {
    excluded: true,
    ...first,
    lines: null,
    obstacle: `A negation in .gitignore does not bring ${entry} back. Change the "${first.rule}" line in ${first.source} instead.`,
  };
}

const PAGES_HEADING = "# Kept for CodeRook Pages: the site is served from this build.";

function withLines(shared: string, lines: string[]): string {
  if (!lines.length) return shared;
  const body = shared.replace(/\s*$/, "");
  return `${body}${body ? "\n\n" : ""}${PAGES_HEADING}\n${lines.join("\n")}\n`;
}

/** Files under a folder the rules would still leave out, a few named. */
async function stillLeftOut(
  root: string,
  folder: string,
  rules: FilterRules,
): Promise<{ count: number; examples: string[] }> {
  const layers = await collectLayers(root, rules);
  const result = { count: 0, examples: [] as string[] };
  const pending = [folder];
  let looked = 0;
  while (pending.length && looked < 20_000) {
    const relative = pending.shift()!;
    for (const entry of await namesIn(path.join(root, ...relative.split("/")))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isUncounted(entry.name)) pending.push(child);
      } else if (entry.isFile()) {
        looked += 1;
        if (excludes(child, false, layers)) {
          result.count += 1;
          if (result.examples.length < 3) result.examples.push(child);
        }
      }
    }
  }
  return result;
}

function nextSteps(projectRef: string): void {
  console.log("");
  console.log("Then, to serve it:");
  console.log(`  1. cbx submit       ${dim("save the folder, build included")}`);
  console.log(`  2. cbx promote      ${dim("publish that save (or make it public from History)")}`);
  console.log(`  3. cbx pages auto${projectRef}   ${dim("turn Pages on with what it finds")}`);
}

async function offerLocalBuild(
  parsed: Parsed,
  root: string,
  builds: LocalBuild[],
  projectRef: string,
): Promise<number> {
  const build = builds[0]!;
  const label = build.folder ? `${build.folder}/` : "the top of the folder";
  console.log(
    `Nothing published can be served yet, but ${kindWords(build.kind)} is here in ${label}.`,
  );
  if (builds.length > 1) {
    console.log(dim(`  Also found: ${builds.slice(1).map((one) => `${one.folder}/`).join(", ")}`));
  }

  const rules = await readRules(root);
  const verdict = await reinclusionFor(root, build.folder, rules);
  if (!verdict.excluded) {
    console.log("It is not in the published version: it has not been saved and published yet.");
    nextSteps(projectRef);
    return 0;
  }

  console.log(
    `Your ignore rules leave ${label} out of every save — "${verdict.rule}" in ${verdict.source}.`,
  );
  console.log(
    dim("  That is right for a repository, where a build can be rebuilt, and wrong for a site."),
  );
  if (!verdict.lines) {
    console.log(accent(`  ${verdict.obstacle}`));
    nextSteps(projectRef);
    return 1;
  }

  console.log("Adding this to .gitignore keeps it in:");
  for (const line of verdict.lines) console.log(`  ${accent(line)}`);

  if (!sure(parsed)) {
    if (!process.stdin.isTTY) return nobodyToAsk("Changing .gitignore");
    if (!(await agreed("Add it to .gitignore? [y/N] "))) {
      console.log(dim("Nothing changed."));
      return 1;
    }
  }

  const changed = { ...rules, shared: withLines(rules.shared, verdict.lines) };
  await writeRules(root, changed);
  console.log(green(`Added to .gitignore. ${label} now goes up with the next save.`));
  const left = await stillLeftOut(root, build.folder, changed);
  if (left.count) {
    console.log(
      accent(
        `  ${left.count} file${left.count === 1 ? "" : "s"} in ${label} ` +
          `${left.count === 1 ? "is" : "are"} still left out by other rules, such as ${left.examples.join(", ")}.`,
      ),
    );
    console.log(dim("  cbx ignore shows the rules in force."));
  }
  nextSteps(projectRef);
  return 0;
}
