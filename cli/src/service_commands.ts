/**
 * Commands about a project as it exists on the service.
 *
 * Issues, releases, people, actions, tokens — the things a folder on disk
 * knows nothing about. Kept apart from the folder commands because they fail
 * differently: these need the network and an account, and none of them can be
 * answered by looking at what is on the machine.
 */

import { commandCheckWorkflows, commandSetWorkflow } from "./actions_command.js";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import {
  acceptInvite,
  addWebhook,
  changeWorkflow,
  collaborators,
  createIssue,
  deleteProject,
  invite,
  issues,
  markRelease,
  releases,
  setReleaseDownloadsPublic,
  whoami,
  versions,
  revokeToken,
  callApi,
  cancelRun,
  rerunRun,
  runLogs,
  runs,
  setWatch,
  tokens,
  watch,
  removeWebhook,
  removeCollaborator,
  revokeInvite,
  redeliverWebhook,
  setCollaboratorRole,
  testWebhook,
  updateWebhook,
  webhookDeliveries,
  webhooks,
  workflows,
  type Webhook,
  type WebhookDelivery,
  type WatchSettings,
} from "./api.js";
import { credentials, readLink } from "./config.js";
import { resolveProject } from "./project_commands.js";
import { Tracks } from "../../cbx/src/core/tracks.js";
import type { Parsed } from "./registry.js";
import { accent, bold, dim, green, red } from "./colour.js";


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
  /*
    `--downloads public|private` decides who can take what is attached,
    apart from the source. Given without a name it changes an existing
    release and nothing else: naming it again would rewrite its notes.
  */
  const downloads = parsed.flags.get("downloads");
  if (downloads !== undefined && downloads !== "public" && downloads !== "private") {
    console.error(red("--downloads is public or private: cbx release v1.0 --downloads public"));
    return 1;
  }
  /* `cbx release publish` publishes a draft (backend release_extras.ts). */
  const publishing = parsed.positional[0] === "publish";
  const name = publishing ? undefined : parsed.positional[0];
  if (!name && downloads === undefined && !publishing) {
    console.error(red("Name the release: cbx release v1.0"));
    return 1;
  }
  const project = await resolveProject(name || publishing ? parsed.positional[1] : parsed.positional[0]);
  if (!project) return 1;
  if (publishing) {
    const listing = await callApi<{ drafts?: Array<{ versionId: string; sequence: number; name: string }> }>(
      `/v1/repositories/${encodeURIComponent(project.id)}/releases`,
    );
    const drafts = listing.drafts ?? [];
    const asked = parsed.flags.get("version");
    const draft =
      typeof asked === "string"
        ? drafts.find((one) => String(one.sequence) === asked.replace(/^v/i, ""))
        : drafts.length === 1
          ? drafts[0]
          : undefined;
    if (!draft) {
      console.error(
        red(drafts.length ? `Which draft? ${drafts.map((one) => `${one.name} (--version ${one.sequence})`).join(", ")}` : "This project has no draft releases."),
      );
      return 1;
    }
    const published = await callApi<{ name: string; sequence: number }>(
      `/v1/repositories/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(draft.versionId)}/release-draft/publish`,
      { method: "POST" },
    );
    console.log(`${green("Published")} ${bold(published.name)} ${dim("at")} v${published.sequence}`);
    return 0;
  }

  const all = await versions(project.id);
  if (!all.length) {
    console.error(red("This project has no versions to release."));
    return 1;
  }

  /*
    The head of the line unless a version is named: a release usually means
    "what I have just finished", and asking for the number every time would
    make the common case the awkward one.

    The head, not the newest number. They differ after `cbx undo`: the line
    goes back to v2 and v3 stays in the history, passed over. Taking the
    newest released exactly the save that was just undone. The line is this
    folder's own when it is linked to this project, otherwise the project's
    default; the newest number is only the answer for a project with no lines.
  */
  const wanted = parsed.flags.get("version");
  let target;
  if (typeof wanted === "string") {
    target = all.find((version) => String(version.sequence) === wanted.replace(/^v/i, ""));
  } else {
    const link = await readLink(process.cwd());
    const lineName = (link?.repositoryId === project.id ? link.track : undefined) ?? project.defaultBranch ?? "main";
    const line = (await new Tracks(credentials).list(project.id)).find(
      (candidate) => candidate.kind === "line" && candidate.name === lineName,
    );
    target =
      (line?.headVersionId && all.find((version) => version.id === line.headVersionId)) ||
      all.reduce((newest, one) => (one.sequence > newest.sequence ? one : newest));
  }
  if (!target) {
    console.error(red(`This project has no version ${String(wanted)}.`));
    return 1;
  }

  let notes = parsed.flags.get("notes");
  /* Notes written from what changed since the last release (release_extras.ts). */
  if (parsed.flags.has("generate-notes")) {
    const written = await callApi<{ notes: string }>(
      `/v1/repositories/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(target.id)}/release-notes`,
    );
    notes = typeof notes === "string" ? `${notes}\n\n${written.notes}` : written.notes;
  }
  const channelFlag = parsed.flags.get("channel");
  const options = {
    ...(parsed.flags.has("prerelease") ? { prerelease: true } : {}),
    ...(typeof channelFlag === "string" ? { channel: channelFlag } : {}),
  };
  if (name && parsed.flags.has("draft")) {
    await callApi(`/v1/repositories/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(target.id)}/release-draft`, {
      method: "PUT",
      body: { name, notes: typeof notes === "string" ? notes : null, ...options },
    });
    console.log(`${green("Drafted")} ${bold(name)} ${dim("at")} v${target.sequence}${dim(" — nothing is public yet.")}`);
    console.log(dim(`  Attach builds with cbx attach, then: cbx release publish --version ${target.sequence}`));
    return 0;
  }
  if (name) {
    try {
      await markRelease(
        project.id,
        target.id,
        name,
        typeof notes === "string" ? notes : null,
        options,
      );
    } catch (error) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    console.log(
      `${green("Released")} ${bold(name)} ${dim("at")} v${target.sequence}` +
        `${dim(" — ")}${target.message.split("\n")[0]!.slice(0, 48)}`,
    );
  }
  if (downloads !== undefined) {
    try {
      await setReleaseDownloadsPublic(project.id, target.id, downloads === "public");
    } catch (error) {
      console.error(red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    console.log(
      downloads === "public"
        ? `${green("Downloads public")} ${dim("on")} v${target.sequence}${dim(
            ": anybody can take what is attached; the source keeps its own visibility.",
          )}`
        : `${green("Downloads private")} ${dim("on")} v${target.sequence}${dim(
            ": only people on this project can take them now.",
          )}`,
    );
    if (downloads === "public" && project.visibility !== "public") {
      console.log(
        dim("  The project itself is not public, so nobody outside it can reach them yet: cbx visibility public."),
      );
    }
  }
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
    const who = release.sourcePublic
      ? "public"
      : release.downloadsPublic
        ? "downloads public"
        : "private";
    console.log(
      `  ${accent(`v${release.sequence}`).padEnd(16)} ` +
        `${(release.name || "—").padEnd(28)} ${when.padEnd(14)} ` +
        `${`${release.assets.length + release.attachments.length} files`.padEnd(10)} ${dim(who)}`,
    );
    const firstLine = release.notes.split("\n")[0];
    if (firstLine) console.log(`    ${dim(firstLine)}`);
  }
  /* Where an app or a script reads them, for a project anybody can reach. */
  const owner =
    project.visibility === "public" && published.some((one) => one.downloadsPublic || one.sourcePublic)
      ? await whoami().then((me) => me.username).catch(() => null)
      : null;
  if (owner) {
    const base = `https://api.coderook.com/v1/public/projects/${encodeURIComponent(owner)}/${encodeURIComponent(project.slug)}`;
    console.log("");
    console.log(dim("  From code, no account needed:"));
    console.log(`  ${dim("latest release")}  ${base}/releases/latest`);
    console.log(`  ${dim("all releases")}    ${base}/releases`);
    console.log(`  ${dim("update feed")}     ${base}/updates`);
  }
  return 0;
}

/** Who can reach a project, and who has been asked. */
export async function commandCollaborators(parsed: Parsed): Promise<number> {
  /*
    Accepting comes first: whoever is joining has no project of theirs to
    name yet. The link is the one from the email, or the one the sender was
    shown; only the token in it matters.
  */
  const link = parsed.flags.get("accept");
  if (link === true) {
    console.error(red("Which invite? Try: cbx people --accept <link from the invite>"));
    return 1;
  }
  if (typeof link === "string" && link.trim()) {
    let token = link.trim();
    try {
      token = new URL(token).searchParams.get("invite") ?? token;
    } catch {
      /* Not a link: taken as the token itself. */
    }
    const joined = await acceptInvite(token);
    console.log(green(`You've joined the project as ${joined.role}.`));
    console.log(dim("  Fetch it with cbx clone <project>; cbx projects lists what you can reach."));
    return 0;
  }

  const project = await resolveProject(parsed.positional[0]);
  if (!project) return 1;

  /*
    Changing a role, taking somebody off, and withdrawing an invite: the rest
    of the website's Collaborators screen. Each names the person by email or
    display name, which is what the listing below shows.
  */
  const changing = parsed.flags.get("change");
  const removing = parsed.flags.get("remove");
  const cancelling = parsed.flags.get("cancel-invite");
  if (changing !== undefined || removing !== undefined || cancelling !== undefined) {
    const wanted = changing ?? removing ?? cancelling;
    if (typeof wanted !== "string" || !wanted.trim()) {
      console.error(red("Who? Name them by email address or display name."));
      return 1;
    }
    const who = wanted.trim().toLowerCase();
    const people = await collaborators(project.id);
    if (cancelling !== undefined) {
      const pending = people.invites.find((one) => one.email.toLowerCase() === who || one.id === wanted.trim());
      if (!pending) {
        console.error(red(`No invite waiting for ${wanted.trim()} on ${project.name}.`));
        return 1;
      }
      await revokeInvite(project.id, pending.id);
      console.log(green(`Withdrew the invite to ${pending.email}. Its link no longer works.`));
      return 0;
    }
    const person = people.collaborators.find(
      (one) =>
        one.email.toLowerCase() === who ||
        one.displayName.toLowerCase() === who ||
        one.userId === wanted.trim(),
    );
    if (!person) {
      console.error(red(`${wanted.trim()} is not one of ${project.name}'s people.`));
      console.error(dim(`  See who is: cbx people ${project.slug}`));
      return 1;
    }
    const label = person.displayName || person.email;
    if (removing !== undefined) {
      await removeCollaborator(project.id, person.userId);
      console.log(green(`${label} is no longer on ${project.name}.`));
      return 0;
    }
    const flag = parsed.flags.get("role");
    const role = typeof flag === "string" ? flag.trim().toLowerCase() : "";
    if (!["write", "read", "admin"].includes(role)) {
      console.error(red(role ? `"${role}" is not a role. Use write, read or admin.` : "Which role? Add --role write, read or admin."));
      return 1;
    }
    await setCollaboratorRole(project.id, person.userId, role);
    console.log(green(`${label} now has ${role} access to ${project.name}.`));
    return 0;
  }

  const email = parsed.flags.get("invite");
  if (email === true) {
    console.error(red("Whose address? Try: --invite someone@example.com"));
    return 1;
  }
  if (typeof email === "string" && email.trim()) {
    /*
      The service knows three roles. The old default, "member", was not one
      of them, so every invite without --role was refused.
    */
    const flag = parsed.flags.get("role");
    const role = typeof flag === "string" ? flag.trim().toLowerCase() : "write";
    if (!["write", "read", "admin"].includes(role)) {
      console.error(red(`"${role}" is not a role. Use write, read or admin.`));
      return 1;
    }
    const sent = await invite(project.id, { email: email.trim(), role });
    console.log(green(`Invited ${email.trim()} to ${project.name}.`));
    /*
      The email can go astray, so the link is handed to the person who sent
      it too. It only works once someone is signed in as that address.
    */
    if (sent.inviteUrl) {
      console.log(dim("  If the email doesn't arrive, send them this link instead:"));
      console.log(`  ${sent.inviteUrl}`);
    }
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
  /* Workspace discussions are their own switch (workspace_threads.ts). */
  const discussions = parsed.flags.get("discussions");
  if (discussions !== undefined) {
    if (discussions !== "all" && discussions !== "off") {
      console.error(red("--discussions must be all or off"));
      return 1;
    }
    await callApi(`/v1/repositories/${encodeURIComponent(project.id)}/workspace-discussions/watch`, {
      method: "PUT",
      body: { level: discussions },
    });
    console.log(
      green(
        discussions === "all"
          ? `Workspace discussions in ${project.name}: new messages reach your notifications.`
          : `Workspace discussions in ${project.name}: off. Threads still show unread counts.`,
      ),
    );
    if (!Object.keys(change).length) return 0;
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
  /* `cbx actions check …` and `cbx actions set …` (actions_command.ts). */
  if (parsed.positional[0] === "check") return commandCheckWorkflows(parsed);
  if (parsed.positional[0] === "set") return commandSetWorkflow(parsed);
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

  /*
    --follow: keep printing as the runner sends, until the run ends. A build
    that takes ten minutes shows its progress rather than nothing.
  */
  if (parsed.flags.has("follow")) {
    console.log(`${accent(`#${run.number}`)} ${bold(run.workflow)} — following until it ends`);
    let shown = 0;
    let state = run;
    for (;;) {
      const lines = await runLogs(project.id, run.id);
      for (const line of lines.slice(shown)) console.log(line.stream === "stderr" ? red(line.line) : line.line);
      shown = Math.max(shown, lines.length);
      if (state.status !== "queued" && state.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      state = (await runs(project.id)).find((one) => one.id === run.id) ?? state;
    }
    console.log(`${statusText(state.status)}${state.summary ? ` · ${dim(state.summary)}` : ""}`);
    return state.status === "failed" ? 1 : 0;
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

/** Stop a run that is waiting or working, by the number people say. */
export async function commandCancel(parsed: Parsed): Promise<number> {
  const asked = parsed.positional[0];
  const number = Number((asked ?? "").replace(/^#/, ""));
  if (!asked || !Number.isInteger(number) || number < 1) {
    console.error(red("Which run? Try: cbx cancel 12"));
    return 1;
  }
  const project = await resolveProject(parsed.positional[1]);
  if (!project) return 1;
  const run = (await runs(project.id)).find((one) => one.number === number);
  if (!run) {
    console.error(red(`${project.name} has no run #${number}.`));
    return 1;
  }
  if (run.status !== "queued" && run.status !== "running") {
    console.error(red(`#${number} has already finished (${run.status}).`));
    return 1;
  }
  await cancelRun(project.id, run.id);
  console.log(`${accent(`#${number}`)} cancelled. A runner working on it stops at its next heartbeat.`);
  return 0;
}

/** Run a finished run again, against the same save. */
export async function commandRerun(parsed: Parsed): Promise<number> {
  const asked = parsed.positional[0];
  const number = Number((asked ?? "").replace(/^#/, ""));
  if (!asked || !Number.isInteger(number) || number < 1) {
    console.error(red("Which run? Try: cbx rerun 12"));
    return 1;
  }
  const project = await resolveProject(parsed.positional[1]);
  if (!project) return 1;
  const run = (await runs(project.id)).find((one) => one.number === number);
  if (!run) {
    console.error(red(`${project.name} has no run #${number}.`));
    return 1;
  }
  if (run.status === "queued" || run.status === "running") {
    console.error(red(`#${number} is still going. Cancel it first with cbx cancel ${number}.`));
    return 1;
  }
  const queued = await rerunRun(project.id, run.id);
  console.log(`${accent(`#${queued.number}`)} queued: #${number} again, against the same save.`);
  console.log(dim(`Follow it with: cbx logs ${queued.number} --follow`));
  return 0;
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
      `This deletes ${bold(project.name)} — ${project.versionCount} ` +
        `${project.versionCount === 1 ? "version" : "versions"}, ` +
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

  /*
    Everything else the website's Webhooks card does to one hook: send a test,
    read what was delivered, send one again, change its events, switch it back
    on. Each names the hook by id or address, as --remove does.
  */
  const tested = parsed.flags.get("test");
  const history = parsed.flags.get("deliveries");
  const resend = parsed.flags.get("redeliver");
  const resume = parsed.flags.get("on");
  const named = parsed.flags.get("hook");
  const changingEvents = parsed.flags.has("events");
  if (tested !== undefined || history !== undefined || resend !== undefined || resume !== undefined || changingEvents) {
    const wanted = [tested, history, resume, named].find((value) => typeof value === "string" && value.trim());
    const hook = await whichHook(project.id, project.name, typeof wanted === "string" ? wanted.trim() : null);
    if (!hook) return 1;

    if (tested !== undefined) {
      const delivery = await testWebhook(project.id, hook.id);
      console.log(`Sent a test to ${hook.url}.`);
      console.log(`  ${deliveryLine(delivery)}`);
      return delivery.state === "delivered" ? 0 : 1;
    }

    if (history !== undefined) {
      const found = await webhookDeliveries(project.id, hook.id);
      if (!found.length) {
        console.log(dim(`Nothing has been sent to ${hook.url} yet. Send a test: cbx hooks --test ${hook.id}`));
        return 0;
      }
      console.log(bold(hook.url));
      for (const delivery of found) console.log(`  ${deliveryLine(delivery)}`);
      console.log("");
      console.log(dim(`  Send one again: cbx hooks --redeliver <delivery> --hook ${hook.id}`));
      return 0;
    }

    if (resend !== undefined) {
      if (typeof resend !== "string" || !resend.trim()) {
        console.error(red("Which delivery?") + dim(`  cbx hooks --deliveries ${hook.id} lists them`));
        return 1;
      }
      /* The start of an id is enough, as long as it picks out one. */
      const prefix = resend.trim().toLowerCase();
      const matches = (await webhookDeliveries(project.id, hook.id)).filter((one) => one.id.toLowerCase().startsWith(prefix));
      if (matches.length !== 1) {
        console.error(
          red(matches.length ? `${resend.trim()} matches more than one delivery; give more of its id.` : `No recent delivery ${resend.trim()} for ${hook.url}.`),
        );
        return 1;
      }
      const delivery = await redeliverWebhook(project.id, hook.id, matches[0]!.id);
      console.log(`Sent ${matches[0]!.event} to ${hook.url} again.`);
      console.log(`  ${deliveryLine(delivery)}`);
      return delivery.state === "delivered" ? 0 : 1;
    }

    if (changingEvents) {
      const value = parsed.flags.get("events");
      const text = typeof value === "string" ? value.trim() : "";
      const events = text === "all" ? [] : text.split(",").map((one) => one.trim()).filter(Boolean);
      if (!events.length && text !== "all") {
        console.error(red("Which events? A comma separated list, or all.") + dim("  cbx hooks --hook <id> --events version.published"));
        return 1;
      }
      await updateWebhook(project.id, hook.id, { events });
    }
    if (resume !== undefined) {
      await updateWebhook(project.id, hook.id, { active: true });
    }
    const after = (await webhooks(project.id)).find((one) => one.id === hook.id) ?? hook;
    console.log(green(`Updated ${hook.url}.`));
    console.log(
      `  ${after.active ? green("on") : red("off")}  ${dim(after.events.length ? after.events.join(", ") : "everything")}`,
    );
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
  if (found.some((hook) => !hook.active)) {
    console.log("");
    console.log(dim("  Switch one back on: cbx hooks --on <id>"));
  }
  return 0;
}

/**
 * The hook a command is about: named by id or address, or the only one.
 *
 * Naming none is fine when there is exactly one, which is the usual case and
 * the one where asking "which?" would be a question with one answer.
 */
async function whichHook(projectId: string, projectName: string, wanted: string | null): Promise<Webhook | null> {
  const found = await webhooks(projectId);
  if (!wanted) {
    if (found.length === 1) return found[0]!;
    console.error(
      red(found.length ? `${projectName} has ${found.length} webhooks. Say which: --hook <id>` : `${projectName} notifies nothing.`),
    );
    return null;
  }
  const hook = found.find((one) => one.id === wanted || one.url === wanted);
  if (!hook) console.error(red(`${projectName} has no webhook called ${wanted}.`));
  return hook ?? null;
}

/** One delivery on one line: when, what, how it went, and its id. */
function deliveryLine(delivery: WebhookDelivery): string {
  const when = new Date(delivery.createdAt).toLocaleString();
  const how =
    delivery.state === "delivered"
      ? green(`delivered${delivery.status ? ` (${delivery.status})` : ""}`)
      : delivery.state === "pending"
        ? dim(`waiting, ${delivery.attempts} ${delivery.attempts === 1 ? "try" : "tries"} so far`)
        : red(`${delivery.state}${delivery.status ? ` (${delivery.status})` : ""}`);
  const detail = delivery.detail && delivery.state !== "delivered" ? dim(`  ${delivery.detail}`) : "";
  return `${dim(delivery.id.slice(0, 8))}  ${when.padEnd(22)} ${delivery.event.padEnd(24)} ${how}${detail}`;
}
