/**
 * The rest of a project's Settings, from a terminal.
 *
 *   cbx about [project] [--name …] [--description …]       General: name, description, address
 *   cbx features [project] [--issues everyone] …           General: which parts, and who sees each
 *   cbx line-rules [line] [--protect] [--approvals n] …     Lines & reviews, per line
 *   cbx upload-rules [--ignore file] [--encrypt off] …     Files & privacy: encrypted upload rules
 *   cbx assistant [manual|automated] [--review on] …       Automation: the pull-request assistant
 *   cbx hand-over <user> [project]                          Danger zone: offer the project to somebody
 *
 * Each one shows what is set when given nothing to change, because "what is
 * this set to" is most of what people ask, and changes only what was named.
 * They call the routes the website's Settings screen calls, so the service
 * decides who may change what — owners and admins, mostly — and its refusal
 * is printed as it is.
 *
 * AI access is the one setting with no command here that changes it: a
 * person changes it on the website or in the desktop app (see `cbx ai`).
 */
import process from "node:process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { callApi, ServiceError, updateProject } from "./api.js";
import { siteOrigin } from "./config.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";

function flagText(parsed: Parsed, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * `on`/`off` and the other ways people say them. Undefined when the flag was
 * not given; null when it was given and is neither.
 */
export function onOff(parsed: Parsed, name: string): boolean | null | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) return true;
  const text = value.trim().toLowerCase();
  if (["on", "true", "yes", "y", "1"].includes(text)) return true;
  if (["off", "false", "no", "n", "0"].includes(text)) return false;
  return null;
}

const repositoryRoute = (id: string) => `/v1/repositories/${encodeURIComponent(id)}`;

/* ------------------------------------------------------------------ about -- */

type RepositoryRecord = {
  displayName?: string;
  description?: string;
  slug?: string;
  visibility?: string;
  ownerHandle?: string | null;
};

/** General: the project's name, description and address. */
export async function commandAbout(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0] ?? flagText(parsed, "project"));
  if (!project) return 1;

  const change: { displayName?: string; description?: string } = {};
  const name = flagText(parsed, "name");
  if (parsed.flags.has("name")) {
    if (!name?.trim()) {
      console.error(red('Give the new name: --name "Night Owl Diner"'));
      return 1;
    }
    if (name.trim().length > 160) {
      console.error(red("A project's name is at most 160 characters."));
      return 1;
    }
    change.displayName = name.trim();
  }
  if (parsed.flags.has("description")) {
    /* An empty description is allowed: it is how one is cleared. */
    const description = flagText(parsed, "description") ?? "";
    if (description.trim().length > 1000) {
      console.error(red("A description is at most 1000 characters."));
      return 1;
    }
    change.description = description.trim();
  }
  if (Object.keys(change).length) {
    await updateProject(project.id, change);
    console.log(green(`Saved ${change.displayName ?? project.name}.`));
    console.log("");
  }

  const record = await callApi<RepositoryRecord>(repositoryRoute(project.id));
  const slug = record.slug ?? project.slug;
  const site = siteOrigin();
  const address = record.ownerHandle
    ? site
      ? `${site}/${encodeURIComponent(record.ownerHandle)}/${encodeURIComponent(slug)}`
      : `${record.ownerHandle}/${slug}`
    : slug;
  console.log(`  ${dim("Name".padEnd(12))} ${bold(record.displayName || project.name)}`);
  console.log(`  ${dim("Description".padEnd(12))} ${record.description?.trim() ? record.description.trim() : dim("none")}`);
  console.log(`  ${dim("Address".padEnd(12))} ${address}`);
  console.log(`  ${dim("Visibility".padEnd(12))} ${record.visibility ?? project.visibility}`);
  if (!Object.keys(change).length) {
    console.log("");
    console.log(dim('  Change them: cbx about --name "…" --description "…"'));
  }
  return 0;
}

/* --------------------------------------------------------------- features -- */

const FEATURE_FLAGS = [
  ["issues", "Issues"],
  ["pulls", "Pull requests"],
  ["actions", "Actions"],
  ["analytics", "Analytics"],
  ["collaborators", "Collaborators"],
  ["storage", "Storage"],
] as const;
type FeatureChoice = "off" | "members" | "everyone";

/** What a choice means for visitors, said beside it. */
function describeChoice(choice: FeatureChoice): string {
  return choice === "everyone" ? green("everyone") : choice === "members" ? "members" : dim("off");
}

/**
 * General → Features: which parts a project has, and who sees each. Off takes
 * the tab away for everybody; members keeps it for the project's people;
 * everyone shows it to visitors of a public project too. Storage is never
 * everyone's.
 */
export async function commandFeatures(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0] ?? flagText(parsed, "project"));
  if (!project) return 1;

  const change: Record<string, FeatureChoice> = {};
  for (const [flag, label] of FEATURE_FLAGS) {
    if (!parsed.flags.has(flag)) continue;
    const given = (flagText(parsed, flag) ?? "").trim().toLowerCase();
    const choice = given === "on" ? "members" : given;
    if (choice !== "off" && choice !== "members" && choice !== "everyone") {
      console.error(red(`--${flag} is off, members or everyone.`));
      return 1;
    }
    if (flag === "storage" && choice === "everyone") {
      console.error(red(`${label} is your account's quota, so it is never shown to visitors.`));
      return 1;
    }
    change[flag] = choice;
  }

  const found = Object.keys(change).length
    ? await callApi<{ access: Record<string, FeatureChoice> }>(`${repositoryRoute(project.id)}/features`, {
        method: "PUT",
        body: change,
      })
    : await callApi<{ access: Record<string, FeatureChoice> }>(`${repositoryRoute(project.id)}/features`);
  if (Object.keys(change).length) {
    console.log(green(`Saved what ${project.name} shows.`));
    console.log("");
  }
  for (const [flag, label] of FEATURE_FLAGS) {
    console.log(`  ${dim(label.padEnd(15))} ${describeChoice(found.access?.[flag] ?? "members")}`);
  }
  if (project.visibility !== "public" && Object.values(found.access ?? {}).includes("everyone")) {
    console.log("");
    console.log(dim("  Visitors see the parts set to everyone once the project is public."));
  }
  if (!Object.keys(change).length) {
    console.log("");
    console.log(dim("  Change them: cbx features --issues everyone --actions members --analytics off"));
  }
  return 0;
}

/* ------------------------------------------------------------- line rules -- */

type Line = {
  name: string;
  kind: string;
  protected: boolean;
  requiredApprovals: number;
  requiredChecks: string[];
  requireCodeOwner: boolean;
};

function describeLine(line: Line): string[] {
  const rules = [
    line.protected ? green("protected") : dim("not protected"),
    line.requiredApprovals
      ? `${line.requiredApprovals} ${line.requiredApprovals === 1 ? "approval" : "approvals"}`
      : dim("no approvals needed"),
    line.requireCodeOwner ? "code owners must approve" : "",
  ].filter(Boolean);
  const lines = [`  ${accent(line.name.padEnd(16))} ${rules.join(dim(" · "))}`];
  if (line.requiredChecks.length) lines.push(`  ${" ".repeat(16)} ${dim("checks:")} ${line.requiredChecks.join(", ")}`);
  return lines;
}

/**
 * Lines & reviews: protection, approvals, required checks and code owners,
 * one line at a time. `cbx tracks` lists the lines and is left as it was;
 * this is where their rules are read and set.
 */
export async function commandLineRules(parsed: Parsed): Promise<number> {
  const project = await resolveProject(flagText(parsed, "project"));
  if (!project) return 1;
  const base = repositoryRoute(project.id);
  const wanted = parsed.positional[0];

  const protect = parsed.flags.has("protect");
  const unprotect = parsed.flags.has("unprotect");
  if (protect && unprotect) {
    console.error(red("Pick one: --protect or --unprotect."));
    return 1;
  }
  let approvals: number | undefined;
  if (parsed.flags.has("approvals")) {
    approvals = Number(flagText(parsed, "approvals"));
    if (!Number.isInteger(approvals) || approvals < 0 || approvals > 10) {
      console.error(red("Approvals is a whole number from 0 to 10."));
      return 1;
    }
  }
  let checks: string[] | undefined;
  if (parsed.flags.has("checks")) {
    const text = (flagText(parsed, "checks") ?? "").trim();
    checks = text === "none" ? [] : text.split(",").map((one) => one.trim()).filter(Boolean);
  }
  const owners = onOff(parsed, "code-owners");
  if (owners === null) {
    console.error(red("--code-owners is on or off."));
    return 1;
  }
  const changing = protect || unprotect || approvals !== undefined || checks !== undefined || owners !== undefined;

  const { tracks } = await callApi<{ tracks: Line[] }>(`${base}/tracks`);
  const lines = tracks
    .filter((track) => (track.kind ?? "line") === "line")
    .map((track) => ({
      ...track,
      requiredApprovals: Number(track.requiredApprovals ?? 0),
      requiredChecks: Array.isArray(track.requiredChecks) ? track.requiredChecks : [],
      requireCodeOwner: track.requireCodeOwner === true,
    }));

  if (changing && !wanted) {
    console.error(red("Which line? cbx line-rules main --protect"));
    return 1;
  }
  const line = wanted ? lines.find((one) => one.name === wanted) : undefined;
  if (wanted && !line) {
    console.error(red(`No line called "${wanted}" on ${project.slug}.`) + dim("  cbx tracks lists them."));
    return 1;
  }

  if (changing && line) {
    const route = `${base}/tracks/${encodeURIComponent(line.name)}`;
    if (protect || unprotect) {
      await callApi(`${route}/protection`, { method: "PUT", body: { protected: protect } });
    }
    if (approvals !== undefined) {
      await callApi(`${route}/review-policy`, { method: "PUT", body: { requiredApprovals: approvals } });
    }
    if (checks !== undefined || owners !== undefined) {
      await callApi(`${route}/rules`, {
        method: "PUT",
        body: {
          ...(checks !== undefined ? { requiredChecks: checks } : {}),
          ...(owners !== undefined ? { requireCodeOwner: owners } : {}),
        },
      });
    }
    const after = (await callApi<{ tracks: Line[] }>(`${base}/tracks`)).tracks.find((one) => one.name === line.name);
    console.log(green(`Saved the rules for ${line.name}.`));
    if (after) {
      for (const row of describeLine({
        ...after,
        requiredApprovals: Number(after.requiredApprovals ?? 0),
        requiredChecks: Array.isArray(after.requiredChecks) ? after.requiredChecks : [],
        requireCodeOwner: after.requireCodeOwner === true,
      })) console.log(row);
    }
    return 0;
  }

  if (!lines.length) {
    console.log(dim(`${project.slug} has no lines yet. The first save creates main.`));
    return 0;
  }
  console.log(bold(`Rules on ${project.slug}'s lines`));
  for (const one of line ? [line] : lines) for (const row of describeLine(one)) console.log(row);

  /* The CODEOWNERS the service read, so "code owners must approve" names somebody. */
  const { rules } = await callApi<{ rules: Array<{ pattern: string; owners: string[] }> }>(`${base}/code-owners`).catch(
    () => ({ rules: [] as Array<{ pattern: string; owners: string[] }> }),
  );
  console.log("");
  if (rules.length) {
    console.log(dim(`Code owners, from CODEOWNERS on the default line (${rules.length}):`));
    for (const rule of rules.slice(0, 10)) console.log(`  ${rule.pattern.padEnd(24)} ${dim(rule.owners.join(" "))}`);
    if (rules.length > 10) console.log(dim(`  … and ${rules.length - 10} more`));
  } else {
    console.log(dim("No CODEOWNERS file on the default line, so nobody counts as a code owner."));
  }
  console.log("");
  console.log(dim("Change one: cbx line-rules main --protect --approvals 1 --checks build,test --code-owners on"));
  return 0;
}

/* ----------------------------------------------------------- upload rules -- */

type UploadRules = {
  ignoreRules: string;
  keepRules: string;
  encryptSecretFiles: boolean;
  holdPushesForReview: boolean;
  warnLargeFileBytes: number;
};

/** A file's text, `none` for empty, or null with the reason printed. */
function rulesFrom(given: string | true | undefined, flag: string): string | null {
  if (typeof given !== "string" || !given.trim()) {
    console.error(red(`--${flag} takes a file of patterns, one per line (or none to clear them).`));
    return null;
  }
  if (given.trim() === "none") return "";
  const file = path.resolve(given);
  if (!existsSync(file) || !statSync(file).isFile()) {
    console.error(red(`No file at ${file}. --${flag} reads its patterns from a file.`));
    return null;
  }
  return readFileSync(file, "utf8");
}

const MIB = 1024 * 1024;

/**
 * Files & privacy → Encrypted uploads: what uploads leave out and keep,
 * whether recognised secret files are encrypted before storage, and the size
 * that earns a warning. The desktop app and the website's scans read the
 * same rules.
 *
 * The service takes the whole set at once, so what was not named is sent
 * back exactly as it was read.
 */
export async function commandUploadRules(parsed: Parsed): Promise<number> {
  const project = await resolveProject(flagText(parsed, "project") ?? parsed.positional[0]);
  if (!project) return 1;
  const route = `${repositoryRoute(project.id)}/rules`;
  const current = await callApi<UploadRules>(route);

  const next: UploadRules = { ...current };
  let changed = false;
  if (parsed.flags.has("ignore")) {
    const text = rulesFrom(parsed.flags.get("ignore"), "ignore");
    if (text === null) return 1;
    next.ignoreRules = text;
    changed = true;
  }
  if (parsed.flags.has("keep")) {
    const text = rulesFrom(parsed.flags.get("keep"), "keep");
    if (text === null) return 1;
    next.keepRules = text;
    changed = true;
  }
  const encrypt = onOff(parsed, "encrypt");
  const hold = onOff(parsed, "hold-pushes");
  if (encrypt === null || hold === null) {
    console.error(red(`--${encrypt === null ? "encrypt" : "hold-pushes"} is on or off.`));
    return 1;
  }
  if (encrypt !== undefined) {
    next.encryptSecretFiles = encrypt;
    changed = true;
  }
  if (hold !== undefined) {
    next.holdPushesForReview = hold;
    changed = true;
  }
  if (parsed.flags.has("warn-large")) {
    const mib = Number(flagText(parsed, "warn-large"));
    if (!Number.isFinite(mib) || mib < 0) {
      console.error(red("--warn-large is a size in MiB, 0 or more."));
      return 1;
    }
    next.warnLargeFileBytes = Math.round(mib * MIB);
    changed = true;
  }

  if (changed) {
    await callApi(route, {
      method: "PUT",
      body: {
        ignoreRules: next.ignoreRules,
        keepRules: next.keepRules,
        encryptSecretFiles: next.encryptSecretFiles,
        holdPushesForReview: next.holdPushesForReview,
        warnLargeFileBytes: next.warnLargeFileBytes,
      },
    });
    console.log(green(`Saved ${project.name}'s upload rules. The desktop app and the website's scans use them now.`));
    console.log("");
  }

  const shown = changed ? await callApi<UploadRules>(route) : current;
  const block = (title: string, text: string) => {
    console.log(dim(title));
    const rows = text.split(/\r?\n/).filter((row) => row.trim());
    if (!rows.length) console.log(`  ${dim("none")}`);
    for (const row of rows) console.log(`  ${row}`);
  };
  console.log(bold(`Upload rules for ${project.slug}`));
  console.log(`  ${"Encrypt files recognised as secrets".padEnd(38)} ${shown.encryptSecretFiles ? green("on") : red("off")}`);
  console.log(`  ${"Warn about files larger than".padEnd(38)} ${Math.round(Number(shown.warnLargeFileBytes) / MIB)} MiB`);
  console.log(`  ${"Hold pushes below admin for review".padEnd(38)} ${shown.holdPushesForReview ? green("on") : dim("off")}`);
  console.log("");
  block("Ignore rules", shown.ignoreRules ?? "");
  console.log("");
  block("Keep rules", shown.keepRules ?? "");
  if (!changed) {
    console.log("");
    console.log(dim("  Change them: cbx upload-rules --ignore .coderookignore --encrypt on --warn-large 512"));
  }
  return 0;
}

/* -------------------------------------------------------------- assistant -- */

const SWITCHES = [
  ["review", "reviews each pull request"],
  ["describe", "writes the description"],
  ["suggest", "suggests changes"],
  ["change", "makes changes when asked"],
  ["approve", "approves when it finds nothing"],
  ["merge", "merges what it approved"],
] as const;

type AssistantSettings = { mode: "manual" | "automated" } & Record<(typeof SWITCHES)[number][0], boolean>;

type AssistantAnswer = {
  settings: AssistantSettings;
  subscribed: boolean;
  available: boolean;
  allowance?: { percentUsed: number; reviews: number; changes: number; resetsAt: string };
};

/**
 * Automation → PR assistant: manual (only when somebody asks on a pull
 * request) or automated, and what it may do on its own. Changing it needs a
 * repository admin and, for automated, a subscription on the owner's account.
 */
export async function commandAssistant(parsed: Parsed): Promise<number> {
  /* `[mode] [project]`, both optional; a lone word that is not a mode is the project. */
  const [first, second] = parsed.positional;
  const isMode = first === "manual" || first === "automated";
  if (first !== undefined && !isMode && second !== undefined) {
    console.error(red(`"${first}" is not a mode. Pick manual or automated.`));
    return 1;
  }
  const mode = isMode ? (first as AssistantSettings["mode"]) : undefined;
  const project = await resolveProject(flagText(parsed, "project") ?? (isMode ? second : first));
  if (!project) return 1;
  const route = `${repositoryRoute(project.id)}/assistant`;

  const change: Partial<AssistantSettings> = {};
  if (mode) change.mode = mode;
  for (const [name] of SWITCHES) {
    const value = onOff(parsed, name);
    if (value === null) {
      console.error(red(`--${name} is on or off.`));
      return 1;
    }
    if (value !== undefined) change[name] = value;
  }

  let answer = await callApi<AssistantAnswer>(route);
  if (Object.keys(change).length) {
    /*
      Said here rather than left to the service, which quietly turns merging
      off when approving is off: "merge" asked for and not given is worth a
      sentence, not a surprise later.
    */
    const next = { ...answer.settings, ...change };
    if (next.merge && !next.approve) {
      console.error(red("Merging needs approving on too: add --approve on."));
      return 1;
    }
    try {
      await callApi(route, { method: "PUT", body: change });
    } catch (error) {
      if (error instanceof ServiceError && error.code === "assistant_needs_subscription") {
        console.error(red(error.message));
        console.error(dim("  Manual mode stays available: cbx assistant manual"));
        return 1;
      }
      throw error;
    }
    console.log(green(`Saved ${project.name}'s pull-request assistant.`));
    answer = await callApi<AssistantAnswer>(route);
  }

  const settings = answer.settings;
  console.log("");
  console.log(
    `${bold(project.name)} ${dim("pull-request assistant:")} ${accent(settings.mode)}` +
      dim(settings.mode === "manual" ? "  (works only when somebody asks on a pull request)" : "  (works on its own)"),
  );
  for (const [name, meaning] of SWITCHES) {
    console.log(`  ${name.padEnd(9)} ${settings[name] ? green("on ") : dim("off")}  ${dim(meaning)}`);
  }
  console.log("");
  if (!answer.subscribed) {
    console.log(dim("  Automated mode comes with a subscription on the owner's account."));
  }
  if (!answer.available) {
    console.log(dim("  The assistant is not available on this service right now."));
  }
  if (answer.allowance) {
    console.log(
      dim(
        `  This month: ${answer.allowance.percentUsed}% of the allowance used ` +
          `(${answer.allowance.reviews} reviews, ${answer.allowance.changes} changes).`,
      ),
    );
  }
  if (!Object.keys(change).length) {
    console.log(dim("  Change it: cbx assistant automated --review on --describe on"));
  }
  return 0;
}

/* --------------------------------------------------------------- hand-over -- */

type Offer = {
  id: string;
  projectName: string;
  slug: string;
  expiresAt: string;
  keepSenderAccess: boolean;
  fromName?: string;
  fromUsername?: string | null;
  toName?: string;
  toUsername?: string | null;
};

/** A plain line typed at the terminal. */
async function typed(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(question);
  prompt.close();
  return answer.trim();
}

/**
 * Danger zone → Transfer ownership, and answering an offer.
 *
 * An offer, as on the website: nothing moves until the other person accepts,
 * and it lapses after fourteen days. Once accepted it cannot be undone from
 * this side, so it asks for TRANSFER to be typed, as the website does, unless
 * --yes says a script has already decided.
 */
export async function commandHandOver(parsed: Parsed): Promise<number> {
  const first = parsed.positional[0];
  if (!first) {
    console.error(red("To whom? cbx hand-over <username or email> [project]") + dim("   (or: cbx hand-over offers)"));
    return 1;
  }

  if (first === "offers") {
    const { incoming, outgoing } = await callApi<{ incoming: Offer[]; outgoing: Offer[] }>("/v1/account/transfers");
    if (!incoming.length && !outgoing.length) {
      console.log(dim("No projects are being handed to you or by you."));
      return 0;
    }
    const until = (offer: Offer) => `until ${new Date(offer.expiresAt).toLocaleDateString()}`;
    if (incoming.length) {
      console.log(bold("Offered to you"));
      for (const offer of incoming) {
        console.log(`  ${accent(offer.slug.padEnd(24))} from ${offer.fromUsername ?? offer.fromName ?? "?"}  ${dim(`${until(offer)}  ${offer.id}`)}`);
      }
      console.log(dim("  Take one: cbx hand-over accept <project>   Turn one down: cbx hand-over decline <project>"));
    }
    if (outgoing.length) {
      if (incoming.length) console.log("");
      console.log(bold("Offered by you"));
      for (const offer of outgoing) {
        console.log(`  ${accent(offer.slug.padEnd(24))} to ${offer.toUsername ?? offer.toName ?? "?"}  ${dim(`${until(offer)}  ${offer.id}`)}`);
      }
      console.log(dim("  Withdraw one: cbx hand-over cancel <project>"));
    }
    return 0;
  }

  if (first === "accept" || first === "decline" || first === "cancel") {
    const wanted = parsed.positional[1]?.trim();
    if (!wanted) {
      console.error(red(`Which offer? cbx hand-over ${first} <project or offer id>`));
      return 1;
    }
    const { incoming, outgoing } = await callApi<{ incoming: Offer[]; outgoing: Offer[] }>("/v1/account/transfers");
    const pool = first === "cancel" ? outgoing : incoming;
    const offer = pool.find((one) => one.id === wanted || one.slug.toLowerCase() === wanted.toLowerCase());
    if (!offer) {
      console.error(red(`No offer ${first === "cancel" ? "from" : "to"} you for ${wanted}.`) + dim("  cbx hand-over offers lists them."));
      return 1;
    }
    const route = `/v1/account/transfers/${encodeURIComponent(offer.id)}`;
    if (first === "accept") {
      const taken = await callApi<{ displayName?: string }>(`${route}/accept`, { method: "POST" });
      console.log(green(`${taken.displayName ?? offer.projectName} is yours now.`));
    } else if (first === "decline") {
      await callApi(`${route}/decline`, { method: "POST" });
      console.log(green(`Turned down ${offer.projectName}. It stays where it was.`));
    } else {
      await callApi(route, { method: "DELETE" });
      console.log(green(`Withdrew the offer of ${offer.projectName}. It stays yours.`));
    }
    return 0;
  }

  const recipient = first.trim();
  const project = await resolveProject(parsed.positional[1] ?? flagText(parsed, "project"));
  if (!project) return 1;
  const keepAccess = !parsed.flags.has("drop-access");
  const sure = parsed.flags.get("yes") === true || parsed.flags.get("y") === true;

  if (!sure) {
    if (!process.stdin.isTTY) {
      console.error(red(`Handing ${project.name} over needs TRANSFER typed, and nobody is here to type it.`));
      console.error(dim("  Run it in a terminal to be asked, or add --yes."));
      return 1;
    }
    console.log(`This offers ${bold(project.name)} to ${bold(recipient)}.`);
    console.log(dim("  Nothing moves until they accept, and the offer lapses after fourteen days."));
    console.log(dim("  Once they accept, it is theirs: only they can give it back."));
    console.log(
      dim(keepAccess ? "  You keep admin access afterwards (--drop-access to give it up)." : "  You give up your access the moment they accept."),
    );
    if ((await typed("Type TRANSFER to offer it: ")) !== "TRANSFER") {
      console.error(red("That was not TRANSFER. Nothing was offered."));
      return 1;
    }
  }

  const offered = await callApi<{ displayName: string; owner: string; expiresAt: string }>(
    `${repositoryRoute(project.id)}/transfer`,
    { method: "POST", body: { recipient, confirmation: "TRANSFER", keepAccess } },
  );
  console.log(
    green(`${offered.displayName} has been offered to ${offered.owner}.`) +
      ` It stays yours until they accept` +
      (keepAccess ? "." : ", and you give up your access when they do."),
  );
  console.log(dim(`  The offer lapses on ${new Date(offered.expiresAt).toLocaleDateString()}. Withdraw it: cbx hand-over cancel ${project.slug}`));
  return 0;
}
