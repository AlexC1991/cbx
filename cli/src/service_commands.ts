/**
 * Commands about a project as it exists on the service.
 *
 * Issues, releases, people, actions, tokens — the things a folder on disk
 * knows nothing about. Kept apart from the folder commands because they fail
 * differently: these need the network and an account, and none of them can be
 * answered by looking at what is on the machine.
 */

import process from "node:process";
import { createInterface } from "node:readline/promises";

import {
  addWebhook,
  changeWorkflow,
  collaborators,
  createIssue,
  deleteProject,
  invite,
  issues,
  markRelease,
  releases,
  versions,
  revokeToken,
  runLogs,
  runs,
  setWatch,
  tokens,
  watch,
  removeWebhook,
  webhooks,
  workflows,
  type WatchSettings,
} from "./api.js";
import { resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";

const dim = (value: string) => `[2m${value}[0m`;
const bold = (value: string) => `[1m${value}[0m`;
const red = (value: string) => `[31m${value}[0m`;
const green = (value: string) => `[32m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

/** Issues on a project, or open a new one. */
export async function commandIssues(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const title = parsed.flags.get("new");
  if (title === true) {
    console.error(red('What is it about? Try: --new "Crash on export"'));
    return 1;
  }
  if (typeof title === "string" && title.trim()) {
    const body = parsed.flags.get("body");
    /*
      Labels at the moment it is opened, rather than in a second command
      afterwards. The service has always taken them here; nothing had ever
      sent any, so every issue arrived unlabelled and the label filter on the
      website had nothing to filter by until somebody went back and tidied.
    */
    const named = parsed.flags.get("labels");
    const labels =
      typeof named === "string"
        ? named
            .split(",")
            .map((one) => one.trim())
            .filter(Boolean)
        : [];

    /*
      And which save it is about, when it is about one. "It broke" and "it
      broke in v41" are different reports, and only the first could be
      written down.
    */
    const about = parsed.flags.get("version");
    let versionId: string | undefined;
    if (typeof about === "string" && about.trim()) {
      const wanted = about.trim().replace(/^v/i, "");
      const all = await versions(project.id);
      const found = all.find((one) => String(one.sequence) === wanted);
      if (!found) {
        console.error(red(`${project.name} has no version ${about.trim()}.`));
        return 1;
      }
      versionId = found.id;
    }

    const created = await createIssue(project.id, {
      title: title.trim(),
      body: typeof body === "string" ? body : "",
      labels,
      ...(versionId ? { versionId } : {}),
    });
    console.log(green(`Opened issue #${created.number} on ${project.name}.`));
    if (labels.length) console.log(dim(`  labelled ${labels.join(", ")}`));
    if (versionId) console.log(dim(`  about v${about}`));
    return 0;
  }

  const found = await issues(project.id);
  if (!found.issues.length) {
    console.log(dim("No issues on this project."));
    return 0;
  }
  console.log(
    `${bold(project.name)}  ${dim(
      `${found.openCount} open, ${found.closedCount} closed`,
    )}`,
  );
  for (const issue of found.issues) {
    const state = issue.state === "open" ? accent("open") : dim("closed");
    console.log(
      `  ${dim(`#${issue.number}`).padEnd(14)} ${state.padEnd(16)} ${issue.title}`,
    );
    if (issue.labels.length) console.log(`    ${dim(issue.labels.join(", "))}`);
  }
  return 0;
}

/** Published releases, newest first. */
/**
 * Name a version, which is what a release is.
 *
 * The service has had `markRelease` since releases existed, and nothing on
 * this side could reach it — a project could be given a release by the
 * website and by nothing else. That gap is why `git push --tags` needs this:
 * a git tag is a name for a version, so it has to call the same thing a person
 * calls, not a path of its own. A capability git can reach and the CLI cannot
 * would be a feature that exists twice and agrees by luck.
 */
export async function commandRelease(parsed: Parsed): Promise<number> {
  const name = parsed.positional[0];
  if (!name) {
    console.error(red("Name the release: cbx release v1.0"));
    return 1;
  }
  const project = await resolveProject(parsed.positional[1]);
  if (!project) return 1;

  const all = await versions(project.id);
  if (!all.length) {
    console.error(red("This project has no versions to release."));
    return 1;
  }

  /*
    The newest version unless one is named. A release usually means "what I
    have just finished", and asking for the number every time would make the
    common case the awkward one.
  */
  const wanted = parsed.flags.get("version");
  const target =
    typeof wanted === "string"
      ? all.find((version) => String(version.sequence) === wanted.replace(/^v/i, ""))
      /* The newest by number rather than by position in the list. */
      : all.reduce((newest, one) => (one.sequence > newest.sequence ? one : newest));
  if (!target) {
    console.error(red(`This project has no version ${String(wanted)}.`));
    return 1;
  }

  const notes = parsed.flags.get("notes");
  try {
    await markRelease(
      project.id,
      target.id,
      name,
      typeof notes === "string" ? notes : null,
    );
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  console.log(
    `${green("Released")} ${bold(name)} ${dim("at")} v${target.sequence}` +
      `${dim(" — ")}${target.message.split("\n")[0]!.slice(0, 48)}`,
  );
  return 0;
}

export async function commandReleases(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const published = await releases(project.id);
  if (!published.length) {
    console.log(dim("Nothing has been released from this project."));
    return 0;
  }
  console.log(bold(project.name));
  for (const release of published) {
    const when = release.releasedAt
      ? new Date(release.releasedAt).toLocaleDateString()
      : "";
    console.log(
      `  ${accent(`v${release.sequence}`).padEnd(16)} ` +
        `${(release.name || "—").padEnd(28)} ${when.padEnd(14)} ` +
        `${release.assets.length} files`,
    );
    const firstLine = release.notes.split("\n")[0];
    if (firstLine) console.log(`    ${dim(firstLine)}`);
  }
  return 0;
}

/** Who can reach a project, and who has been asked. */
export async function commandCollaborators(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const email = parsed.flags.get("invite");
  if (email === true) {
    console.error(red("Whose address? Try: --invite someone@example.com"));
    return 1;
  }
  if (typeof email === "string" && email.trim()) {
    const role = parsed.flags.get("role");
    await invite(project.id, {
      email: email.trim(),
      role: typeof role === "string" ? role : "member",
    });
    console.log(green(`Invited ${email.trim()} to ${project.name}.`));
    return 0;
  }

  const people = await collaborators(project.id);
  console.log(bold(project.name));
  if (!people.collaborators.length) {
    console.log(dim("  Nobody else has access."));
  }
  for (const person of people.collaborators) {
    console.log(
      `  ${(person.displayName || person.email).padEnd(28)} ${dim(person.role)}`,
    );
  }
  if (people.invites.length) {
    console.log("");
    console.log(dim("  Waiting on a reply"));
    for (const pending of people.invites) {
      console.log(`  ${pending.email.padEnd(28)} ${dim(pending.role)}`);
    }
  }
  return 0;
}

const WATCH_LEVELS = ["everything", "versions", "issues", "releases", "ignore"];

/** What reaches you about a project. */
export async function commandWatch(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const change: Partial<WatchSettings> = {};
  const level = parsed.flags.get("level");
  if (typeof level === "string") {
    if (!WATCH_LEVELS.includes(level)) {
      console.error(red(`Level must be one of: ${WATCH_LEVELS.join(", ")}`));
      return 1;
    }
    change.level = level;
  }
  if (parsed.flags.has("email")) {
    change.emailDigest = parsed.flags.get("email") !== "off";
  }
  if (Object.keys(change).length) {
    await setWatch(project.id, change);
    console.log(green(`Updated what reaches you about ${project.name}.`));
  }

  const settings = await watch(project.id);
  console.log("");
  console.log(bold(project.name));
  console.log(`  Level        ${accent(settings.level)}`);
  console.log(`  In the app   ${settings.inApp ? "yes" : "no"}`);
  console.log(`  Daily email  ${settings.emailDigest ? "yes" : "no"}`);
  console.log("");
  console.log(dim(`  Levels: ${WATCH_LEVELS.join(", ")}`));
  return 0;
}

/** The automations a project has, and how they have been going. */
export async function commandWorkflows(parsed: Parsed): Promise<number> {
  const project = await resolveProject(
    typeof parsed.flags.get("project") === "string"
      ? String(parsed.flags.get("project"))
      : parsed.positional[0],
  );
  if (!project) return 1;

  const found = (await workflows(project.id)).filter(
    (workflow) => !workflow.archivedAt,
  );

  /*
    Setting, before printing. `cbx actions --ship Build` reads as a sentence
    and then shows the list it has just changed, which is the same shape
    `cbx notes` uses: one command, print by default, flags to write.
  */
  const ship = parsed.flags.get("ship");
  const stop = parsed.flags.get("no-ship");
  if (ship !== undefined || stop !== undefined) {
    const wanted = ship !== undefined;
    const named = wanted ? ship : stop;
    if (typeof named !== "string" || !named.trim()) {
      console.error(
        red("Which action?") + dim(`  cbx actions ${wanted ? "--ship" : "--no-ship"} "Build"`),
      );
      return 1;
    }
    const target = found.find(
      (workflow) => workflow.name.toLowerCase() === named.trim().toLowerCase(),
    );
    if (!target) {
      console.error(red(`${project.name} has no action called ${named.trim()}.`));
      if (found.length) {
        console.error(dim(`  It has: ${found.map((one) => one.name).join(", ")}`));
      }
      return 1;
    }
    if (wanted && !target.artifactPaths.length) {
      /*
        Refused rather than set. Shipping what a run collected means nothing
        when the run collects nothing, and a flag that reported success and
        then never produced a download would be indistinguishable from the
        feature being broken.
      */
      console.error(
        red(`${target.name} keeps no files, so it has nothing to ship.`),
      );
      console.error(
        dim("  Give it something to keep on the Actions screen first, e.g. dist/*.exe"),
      );
      return 1;
    }
    try {
      await changeWorkflow(project.id, target.id, { attachArtifacts: wanted });
    } catch (error) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    target.attachArtifacts = wanted;
    console.log(
      wanted
        ? green(`${target.name} will attach what it builds to the version it ran against.`)
        : green(`${target.name} will keep its files without attaching them.`),
    );
    if (wanted) {
      /*
        Said plainly, because attaching is publishing. An attachment on a
        public version is a download anybody can take, and somebody turning
        this on for a workflow that builds an internal tool deserves to hear
        that before the next run rather than after it.
      */
      console.log(
        dim("  Anything it attaches to a public version is public the moment it lands."),
      );
    }
    console.log("");
  }

  /*
    When an action runs. A trigger used to be a label nothing acted on; now a
    save or a proposal really does start the actions that asked for it, so
    choosing is worth a flag.
  */
  const WHEN: Array<[string, string, string]> = [
    ["on-save", "version_saved", "runs on every save"],
    ["on-proposal", "merge_opened", "runs when a line is proposed, and again on each save to it"],
    ["by-hand", "manual", "runs when somebody starts it"],
  ];
  for (const [flag, trigger, meaning] of WHEN) {
    const named = parsed.flags.get(flag);
    if (named === undefined) continue;
    if (typeof named !== "string" || !named.trim()) {
      console.error(red("Which action?") + dim(`  cbx actions --${flag} "Tests"`));
      return 1;
    }
    const target = found.find(
      (workflow) => workflow.name.toLowerCase() === named.trim().toLowerCase(),
    );
    if (!target) {
      console.error(red(`${project.name} has no action called ${named.trim()}.`));
      if (found.length) {
        console.error(dim(`  It has: ${found.map((one) => one.name).join(", ")}`));
      }
      return 1;
    }
    try {
      await changeWorkflow(project.id, target.id, { trigger });
    } catch (error) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    target.trigger = trigger;
    console.log(green(`${target.name} ${meaning}.`));
    if (trigger === "merge_opened") {
      console.log(dim("  Its result becomes a required check on the proposal."));
    }
    console.log("");
  }

  if (!found.length) {
    console.log(dim("No actions on this project."));
    return 0;
  }
  console.log(bold(project.name));
  for (const workflow of found) {
    const health = workflow.runs
      ? `${workflow.passing}/${workflow.runs} passing`
      : "never run";
    console.log(
      `  ${workflow.name.padEnd(24)} ${dim(workflow.trigger).padEnd(20)} ` +
        `${dim(workflow.runsOn).padEnd(18)} ${health}`,
    );
    console.log(`    ${dim(workflow.command)}`);
    if (workflow.artifactPaths.length) {
      console.log(
        `    ${dim("keeps")} ${dim(workflow.artifactPaths.join(", "))}` +
          (workflow.attachArtifacts
            ? ` ${accent("→ downloads on the version")}`
            : ""),
      );
    }
  }
  return 0;
}

const RUN_STATES = ["queued", "running", "passed", "failed", "cancelled"];

/** Colour a status the way somebody scanning the list would want it. */
function statusText(status: string): string {
  if (status === "passed") return green(status);
  if (status === "failed" || status === "cancelled") return red(status);
  if (status === "running") return accent(status);
  return dim(status);
}

function elapsed(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * What has run, and how it went.
 *
 * The runner has always shipped every line of output to the service, and the
 * service has always kept it — but the only way to read any of it back was
 * the website. Somebody running a job from a terminal had to leave the
 * terminal to find out why it failed.
 */
export async function commandRuns(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  const status = parsed.flags.get("status");
  if (typeof status === "string" && !RUN_STATES.includes(status)) {
    console.error(red(`Status must be one of: ${RUN_STATES.join(", ")}`));
    return 1;
  }

  const found = await runs(project.id, {
    status: typeof status === "string" ? status : undefined,
  });
  if (!found.length) {
    console.log(dim("Nothing has run on this project."));
    return 0;
  }

  console.log(bold(project.name));
  for (const run of found) {
    const when = run.startedAt
      ? new Date(run.startedAt).toLocaleString()
      : dim("not started");
    console.log(
      `  ${accent(`#${run.number}`).padEnd(15)} ${statusText(run.status).padEnd(20)} ` +
        `${run.workflow.padEnd(24)} ${elapsed(run.durationMs).padEnd(9)} ${dim(when)}`,
    );
    const aside = [
      run.version === null ? "" : `v${run.version}`,
      run.claimedBy ?? "",
      run.summary,
    ].filter(Boolean);
    if (aside.length) console.log(`    ${dim(aside.join(" · "))}`);
  }
  console.log("");
  console.log(dim("  Read one with: cbx logs <number>"));
  return 0;
}

/**
 * What one run printed.
 *
 * Taken by the number people actually say — "#12 failed" — rather than the
 * identifier the service uses, which nobody has in front of them.
 */
export async function commandLogs(parsed: Parsed): Promise<number> {
  const asked = parsed.positional[0];
  if (!asked) {
    console.error(red("Which run? Try: cbx logs 12"));
    return 1;
  }
  const number = Number(asked.replace(/^#/, ""));
  if (!Number.isInteger(number) || number < 1) {
    console.error(red(`"${asked}" is not a run number.`));
    return 1;
  }

  const project = await resolveProject(parsed.positional[1]);
  if (!project) return 1;

  const found = await runs(project.id);
  const run = found.find((one) => one.number === number);
  if (!run) {
    console.error(red(`${project.name} has no run #${number}.`));
    if (found.length) {
      console.error(
        dim(`  The most recent is #${found[0]?.number}.`),
      );
    }
    return 1;
  }

  const lines = await runLogs(project.id, run.id);
  console.log(
    `${accent(`#${run.number}`)} ${bold(run.workflow)} — ${statusText(run.status)}` +
      `${run.summary ? ` · ${dim(run.summary)}` : ""}`,
  );
  if (!lines.length) {
    /*
      Told apart deliberately. A queued run has printed nothing yet, which is
      normal; a finished run that printed nothing is a workflow whose command
      said nothing, which is worth knowing.
    */
    console.log(
      dim(
        run.status === "queued"
          ? "  Nothing yet; this run has not been picked up."
          : "  This run recorded no output.",
      ),
    );
    return 0;
  }
  for (const line of lines) {
    console.log(line.stream === "stderr" ? red(line.line) : line.line);
  }
  return run.status === "failed" ? 1 : 0;
}

/** The tokens that can act as this account. */
export async function commandTokens(parsed: Parsed): Promise<number> {
  const revoke = parsed.flags.get("revoke");
  if (typeof revoke === "string" && revoke.trim()) {
    await revokeToken(revoke.trim());
    console.log(green("Revoked. Anything using it stops working now."));
    return 0;
  }

  const found = await tokens();
  if (!found.length) {
    console.log(dim("No personal access tokens on this account."));
    return 0;
  }
  for (const token of found) {
    const used = token.lastUsedAt
      ? new Date(token.lastUsedAt).toLocaleDateString()
      : "never used";
    console.log(`  ${token.name.padEnd(26)} ${used.padEnd(16)} ${dim(token.id)}`);
  }
  console.log("");
  console.log(dim("  Revoke one with: cbx tokens --revoke <id>"));
  return 0;
}

/**
 * Delete a project.
 *
 * Asks for the name to be typed rather than a yes. A confirmation somebody can
 * answer without reading is not a confirmation, and this is the command that
 * takes away work.
 */
export async function commandDelete(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  if (parsed.flags.get("yes") !== true) {
    console.log(
      `This deletes ${bold(project.name)} — ${project.versionCount} versions, ` +
        `${bytes(project.storedBytes)}.`,
    );
    console.log(dim("It is kept for 30 days before the storage is reclaimed."));
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const typed = await prompt.question("Type the project name to confirm: ");
    prompt.close();
    const answer = typed.trim();
    if (answer !== project.slug && answer !== project.name) {
      console.error(red("That did not match. Nothing was deleted."));
      return 1;
    }
  }

  await deleteProject(project.id);
  console.log(green(`Deleted ${project.name}.`));
  return 0;
}

/**
 * Where a project tells something else that something happened.
 *
 * The service has been able to do this since Merge Tracks shipped — queue an
 * event, sign it, deliver it after the request that caused it — and nothing
 * could reach it. A project could not be told to notify a build box, a chat
 * room or a status page, because no client asked.
 */
export async function commandHooks(parsed: Parsed): Promise<number> {
  const project = await resolveProject(
    typeof parsed.flags.get("project") === "string"
      ? String(parsed.flags.get("project"))
      : parsed.positional[0],
  );
  if (!project) return 1;

  const adding = parsed.flags.get("add");
  if (adding !== undefined) {
    if (typeof adding !== "string" || !adding.trim()) {
      console.error(red("Which address?") + dim("  cbx hooks --add https://example.com/hook"));
      return 1;
    }
    const url = adding.trim();
    if (!/^https:\/\//i.test(url)) {
      /*
        Refused here as well as by the service. A webhook carries a signed
        payload about a private project, and http would put it on the wire in
        the clear — worth saying before the round trip rather than after.
      */
      console.error(red("A webhook address has to be https."));
      return 1;
    }
    const named = parsed.flags.get("events");
    const events =
      typeof named === "string"
        ? named.split(",").map((one) => one.trim()).filter(Boolean)
        : [];
    try {
      const made = await addWebhook(project.id, url, events);
      console.log(green(`${project.name} will notify ${url}.`));
      console.log("");
      /*
        Printed once because it exists once. The service generates it and no
        route ever hands it back, so this is the only moment anybody can
        write it down — and saying so is the difference between a person
        copying it and a person losing it.
      */
      console.log(`  ${bold("Signing secret")}  ${made.secret}`);
      console.log(
        dim("  Written once and never again. Use it to check the signature on"),
      );
      console.log(dim("  what arrives, so nobody else can post to your endpoint."));
      if (events.length) console.log(dim(`  Sending: ${events.join(", ")}`));
      else console.log(dim("  Sending: everything this project announces"));
    } catch (error) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    return 0;
  }

  const removing = parsed.flags.get("remove");
  if (removing !== undefined) {
    if (typeof removing !== "string" || !removing.trim()) {
      console.error(red("Which one?") + dim("  cbx hooks --remove <id>"));
      return 1;
    }
    const wanted = removing.trim();
    const found = (await webhooks(project.id)).find(
      (one) => one.id === wanted || one.url === wanted,
    );
    if (!found) {
      console.error(red(`${project.name} has no webhook called ${wanted}.`));
      return 1;
    }
    await removeWebhook(project.id, found.id);
    console.log(green(`${found.url} will not be notified any more.`));
    return 0;
  }

  const found = await webhooks(project.id);
  if (!found.length) {
    console.log(dim("This project notifies nothing."));
    console.log(dim("  cbx hooks --add https://example.com/coderook"));
    return 0;
  }
  console.log(bold(project.name));
  for (const hook of found) {
    /*
      A run of failures shown rather than hidden. A webhook that has been
      failing for a week looks exactly like one that works until somebody
      checks the receiving end, which is the wrong place to find out.
    */
    const health = !hook.active
      ? red("off")
      : hook.consecutiveFailures
        ? red(`${hook.consecutiveFailures} failed in a row`)
        : hook.lastDeliveredAt
          ? green("delivering")
          : dim("nothing sent yet");
    console.log(`  ${hook.url}`);
    console.log(
      `    ${dim(hook.id)}  ${health}` +
        (hook.events.length ? `  ${dim(hook.events.join(", "))}` : `  ${dim("everything")}`),
    );
  }
  return 0;
}
