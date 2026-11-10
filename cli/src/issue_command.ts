/**
 * `cbx issue` — one issue at a time, from the terminal.
 *
 *   cbx issue view 12                      the issue, its labels, its timeline and comments
 *   cbx issue comment 12 -m "…"            reply
 *   cbx issue close 12 [--reason not-planned | --duplicate-of 9]
 *   cbx issue reopen 12
 *   cbx issue label 12 bug,ui [--remove]
 *   cbx issue assign 12 sam | none
 *   cbx issue labels [--starter]           the project's labels
 *   cbx issue labels add|change|remove <name> [--colour #hex] [--description …] [--name …]
 *   cbx issue rules                        the project's issue rules, numbered
 *   cbx issue rules add <auto-label|auto-assign|welcome|stale> [settings]
 *   cbx issue rules on|off|change|remove <n>
 *
 * Listing and opening issues stays with `cbx issues` and `cbx issues --new`.
 * Inside a run, CODEROOK_TOKEN and CODEROOK_PROJECT make these work with no
 * setup, so a workflow can comment on or label the issue that started it.
 */
import { callApi } from "./api.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";

type Thread = {
  issue: {
    number: number;
    title: string;
    body: string;
    state: string;
    closeReason?: string | null;
    duplicateOf?: number | null;
    assigneeUserId: string | null;
    labels?: Array<{ name: string }>;
    createdAt: string;
  };
  comments: Array<{ id: string; body: string; author: { displayName: string }; createdAt: string; automated?: boolean }>;
  events?: Array<{ kind: string; actor: string | null; detail: Record<string, unknown>; createdAt: string }>;
};

type IssueRule = { id: string; kind: RuleKind; enabled: boolean; config: Record<string, unknown> };
type RuleKind = "auto_label" | "auto_assign" | "welcome" | "stale";
const RULE_KINDS: RuleKind[] = ["auto_label", "auto_assign", "welcome", "stale"];

function flagValue(parsed: Parsed, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * `cbx issue labels add|change|remove <name>`. Answers 0 when the list should
 * follow, as it does after a change.
 */
async function changeLabel(parsed: Parsed, base: string, action: string): Promise<number> {
  const name = parsed.positional[2]?.trim();
  if (!["add", "change", "remove"].includes(action)) {
    console.error(red(`cbx issue labels has no "${action}". `) + "Try: add, change, remove");
    return 1;
  }
  if (!name) {
    console.error(red(`Which label? cbx issue labels ${action} bug`));
    return 1;
  }
  const route = `${base}/issue-labels/${encodeURIComponent(name)}`;
  if (action === "remove") {
    await callApi(route, { method: "DELETE" });
    console.log(green(`Removed the label ${name}. Issues that had it keep everything else.`));
    return 0;
  }
  const { labels } = await callApi<{ labels: Array<{ name: string }> }>(`${base}/issue-labels`);
  const exists = labels.some((label) => label.name === name);
  /*
    The service creates a label it does not have and changes one it does,
    through the same request. Asked first here so a typo in `change` is not
    quietly a new label, and `add` of an existing one is not a quiet edit.
  */
  if (action === "add" && exists) {
    console.error(red(`There is already a label called ${name}. Change it: cbx issue labels change ${name} --colour d73a4a`));
    return 1;
  }
  if (action === "change" && !exists) {
    console.error(red(`No label called ${name}. Add it: cbx issue labels add ${name}`));
    return 1;
  }
  const change: { name?: string; colour?: string; description?: string | null } = {};
  const rename = flagValue(parsed, "name");
  const colour = flagValue(parsed, "colour", "color");
  const description = flagValue(parsed, "description");
  if (rename !== undefined) change.name = rename.trim();
  if (colour !== undefined) change.colour = colour.trim().startsWith("#") ? colour.trim() : `#${colour.trim()}`;
  if (description !== undefined) change.description = description.trim() || null;
  if (action === "change" && !Object.keys(change).length) {
    console.error(red("Change what? --name, --colour or --description"));
    return 1;
  }
  await callApi(route, { method: "PUT", body: change });
  console.log(green(action === "add" ? `Added the label ${name}.` : `Changed the label ${name}${change.name && change.name !== name ? ` (now ${change.name})` : ""}.`));
  return 0;
}

/** A rule's settings from the flags, over what it had. */
function ruleConfig(parsed: Parsed, kind: RuleKind, current: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = { ...current };
  const list = (value: string) => value.split(",").map((one) => one.trim()).filter(Boolean);
  const words = flagValue(parsed, "words");
  const label = flagValue(parsed, "label");
  const where = flagValue(parsed, "in");
  const assignees = flagValue(parsed, "assignees");
  const message = flagValue(parsed, "m", "message");
  const days = flagValue(parsed, "days");
  const closeAfter = flagValue(parsed, "close-after");
  const exempt = flagValue(parsed, "exempt");
  if (kind === "auto_label") {
    if (words !== undefined) config.words = list(words);
    if (label !== undefined) config.label = label.trim();
    if (where !== undefined) config.in = where.trim();
  } else if (kind === "auto_assign") {
    if (assignees !== undefined) config.assignees = list(assignees).map((one) => one.replace(/^@/, ""));
    if (label !== undefined) config.label = label.trim() || null;
  } else if (kind === "welcome") {
    if (message !== undefined) config.message = message;
  } else {
    if (days !== undefined) config.days = Number(days);
    if (closeAfter !== undefined) config.closeAfterDays = Number(closeAfter);
    if (label !== undefined) config.label = label.trim();
    if (message !== undefined) config.message = message;
    if (exempt !== undefined) config.exemptLabels = list(exempt);
  }
  return config;
}

/**
 * `cbx issue rules add <kind> …`, and `on|off|change|remove <n>`, where n is
 * the number the list shows (or the rule's id). Answers 0 when the list
 * should follow.
 */
async function changeRule(parsed: Parsed, base: string, action: string): Promise<number> {
  if (action === "add") {
    const kind = (parsed.positional[2] ?? "").replace("-", "_") as RuleKind;
    if (!RULE_KINDS.includes(kind)) {
      console.error(red("Which kind? auto-label, auto-assign, welcome or stale."));
      return 1;
    }
    await callApi(`${base}/issue-rules`, { method: "POST", body: { kind, config: ruleConfig(parsed, kind, {}) } });
    console.log(green(`Added a ${kind.replace("_", "-")} rule.`));
    return 0;
  }
  if (!["on", "off", "change", "remove"].includes(action)) {
    console.error(red(`cbx issue rules has no "${action}". `) + "Try: add, on, off, change, remove");
    return 1;
  }
  const wanted = (parsed.positional[2] ?? "").replace(/^#/, "").trim();
  const { rules } = await callApi<{ rules: IssueRule[] }>(`${base}/issue-rules`);
  const index = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1;
  const rule = rules[index] ?? rules.find((one) => one.id === wanted);
  if (!rule) {
    console.error(red(wanted ? `No rule ${wanted}. cbx issue rules lists them, numbered.` : `Which rule? cbx issue rules ${action} 2`));
    return 1;
  }
  const route = `${base}/issue-rules/${encodeURIComponent(rule.id)}`;
  if (action === "remove") {
    await callApi(route, { method: "DELETE" });
    console.log(green(`Removed the ${rule.kind.replace("_", "-")} rule.`));
    return 0;
  }
  if (action === "change") {
    await callApi(route, { method: "PATCH", body: { config: ruleConfig(parsed, rule.kind, rule.config) } });
  } else {
    await callApi(route, { method: "PATCH", body: { enabled: action === "on" } });
  }
  console.log(green(action === "change" ? `Changed the ${rule.kind.replace("_", "-")} rule.` : `The ${rule.kind.replace("_", "-")} rule is ${action}.`));
  return 0;
}

function text(parsed: Parsed): string | null {
  const message = parsed.flags.get("m") ?? parsed.flags.get("message");
  return typeof message === "string" && message.trim() ? message : null;
}

function eventLine(event: NonNullable<Thread["events"]>[number]): string {
  const who = event.actor ?? "A rule";
  const detail = event.detail;
  switch (event.kind) {
    case "closed":
      return `${who} closed it (${String(detail.reason ?? "completed").replace("_", " ")})`;
    case "marked_duplicate":
      return `${who} closed it as a duplicate of #${String(detail.duplicateOf)}`;
    case "reopened":
      return `${who} reopened it`;
    case "labeled":
      return `${who} added ${String(detail.label)}`;
    case "unlabeled":
      return `${who} removed ${String(detail.label)}`;
    case "assigned":
      return `${who} assigned it`;
    case "unassigned":
      return `${who} removed the assignee`;
    case "renamed":
      return `${who} renamed it from "${String(detail.from)}"`;
    case "referenced":
      return `${who} mentioned it in ${detail.sourceKind === "pull" ? String(detail.reference) : `#${String(detail.number)}`}`;
    default:
      return `${who} ${event.kind}`;
  }
}

export async function commandIssue(parsed: Parsed): Promise<number> {
  const sub = parsed.positional[0] ?? "";
  const named = parsed.flags.get("project");
  const project = await resolveProject(typeof named === "string" ? named : undefined);
  if (!project) return 1;
  const base = `/v1/repositories/${encodeURIComponent(project.id)}`;

  if (sub === "labels") {
    const action = parsed.positional[1];
    if (action) {
      const changed = await changeLabel(parsed, base, action);
      if (changed !== 0) return changed;
    }
    if (parsed.flags.has("starter")) {
      const { added } = await callApi<{ added: number }>(`${base}/issue-labels/starter`, { method: "POST" });
      console.log(green(added ? `Added ${added} labels.` : "The usual labels are already there."));
    }
    const { labels } = await callApi<{ labels: Array<{ name: string; colour: string; description: string | null; open: number }> }>(`${base}/issue-labels`);
    if (!labels.length) {
      console.log(`${bold(project.slug)} has no labels. ${dim("Add the usual set: cbx issue labels --starter")}`);
      return 0;
    }
    for (const label of labels) {
      console.log(`  ${accent(label.name.padEnd(20))} ${dim(`${label.colour}  ${label.open} open${label.description ? `  ${label.description}` : ""}`)}`);
    }
    return 0;
  }

  if (sub === "rules") {
    const action = parsed.positional[1];
    if (action) {
      const changed = await changeRule(parsed, base, action);
      if (changed !== 0) return changed;
    }
    const { rules } = await callApi<{ rules: IssueRule[] }>(`${base}/issue-rules`);
    if (!rules.length) {
      console.log(`${bold(project.slug)} has no issue rules. ${dim('Add one: cbx issue rules add welcome -m "Thanks for the report!"')}`);
      return 0;
    }
    rules.forEach((rule, index) => {
      console.log(`  ${accent(String(index + 1).padStart(2))} ${rule.enabled ? green("on ") : dim("off")} ${accent(rule.kind.padEnd(12))} ${dim(JSON.stringify(rule.config))}`);
    });
    if (!action) console.log(dim("\n  Change one by its number: cbx issue rules off 2, cbx issue rules remove 2"));
    return 0;
  }

  const number = Number((parsed.positional[1] ?? "").replace(/^#/, ""));
  if (!Number.isInteger(number) || number < 1) {
    console.error(red(`Which issue? Try: cbx issue ${sub || "view"} 12`));
    return 1;
  }
  const at = `${base}/issues/${number}`;

  switch (sub) {
    case "view": {
      const thread = await callApi<Thread>(at);
      const issue = thread.issue;
      console.log(`${bold(`#${issue.number} ${issue.title}`)}  ${issue.state === "open" ? green("open") : dim(`closed${issue.closeReason ? ` (${issue.closeReason.replace("_", " ")}${issue.duplicateOf ? ` of #${issue.duplicateOf}` : ""})` : ""}`)}`);
      if (issue.labels?.length) console.log(dim(`  labels: ${issue.labels.map((label) => label.name).join(", ")}`));
      console.log("");
      console.log(issue.body || dim("(no description)"));
      const stream = [
        ...thread.comments.map((comment) => ({ at: comment.createdAt, line: `\n${accent(comment.automated ? "Project rule" : comment.author.displayName)} ${dim(new Date(comment.createdAt).toLocaleString())}\n${comment.body}` })),
        ...(thread.events ?? []).filter((event) => event.kind !== "opened").map((event) => ({ at: event.createdAt, line: dim(`  · ${eventLine(event)}, ${new Date(event.createdAt).toLocaleString()}`) })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      for (const item of stream) console.log(item.line);
      return 0;
    }
    case "comment": {
      const body = text(parsed);
      if (!body) {
        console.error(red('Say something: cbx issue comment 12 -m "Fixed in v41"'));
        return 1;
      }
      await callApi(`${at}/comments`, { method: "POST", body: { body } });
      console.log(green(`Replied on #${number}.`));
      return 0;
    }
    case "close": {
      const duplicate = parsed.flags.get("duplicate-of");
      const reasonFlag = parsed.flags.get("reason");
      const reason =
        typeof duplicate === "string"
          ? "duplicate"
          : typeof reasonFlag === "string"
            ? reasonFlag.replace("-", "_")
            : "completed";
      if (!["completed", "not_planned", "duplicate"].includes(reason)) {
        console.error(red("A reason is completed, not-planned, or --duplicate-of <n>."));
        return 1;
      }
      await callApi(at, {
        method: "PATCH",
        body: {
          state: "closed",
          reason,
          ...(typeof duplicate === "string" ? { duplicateOf: Number(duplicate.replace(/^#/, "")) } : {}),
        },
      });
      const body = text(parsed);
      if (body) await callApi(`${at}/comments`, { method: "POST", body: { body } });
      console.log(green(`Closed #${number}${reason === "completed" ? "" : ` (${reason.replace("_", " ")})`}.`));
      return 0;
    }
    case "reopen":
      await callApi(at, { method: "PATCH", body: { state: "open" } });
      console.log(green(`Reopened #${number}.`));
      return 0;
    case "label": {
      const names = (parsed.positional[2] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
      if (!names.length) {
        console.error(red("Which labels? cbx issue label 12 bug,ui"));
        return 1;
      }
      const remove = parsed.flags.has("remove");
      for (const name of names) {
        await callApi(`${at}/labels/${encodeURIComponent(name)}`, { method: remove ? "DELETE" : "PUT" });
      }
      console.log(green(`${remove ? "Removed" : "Added"} ${names.join(", ")} ${remove ? "from" : "on"} #${number}.`));
      return 0;
    }
    case "assign": {
      const who = (parsed.positional[2] ?? "").replace(/^@/, "").trim();
      if (!who) {
        console.error(red("To whom? cbx issue assign 12 sam  (or none)"));
        return 1;
      }
      let assigneeUserId: string | null = null;
      if (who !== "none") {
        const { people } = await callApi<{ people: Array<{ id: string; name: string; username: string | null }> }>(`${base}/assignable`);
        const person = people.find((one) => (one.username ?? "").toLowerCase() === who.toLowerCase() || one.name.toLowerCase() === who.toLowerCase());
        if (!person) {
          console.error(red(`${who} is not on ${project.name}. It can go to: ${people.map((one) => one.username ?? one.name).join(", ")}`));
          return 1;
        }
        assigneeUserId = person.id;
      }
      await callApi(at, { method: "PATCH", body: { assigneeUserId } });
      console.log(green(assigneeUserId ? `#${number} is ${who}'s now.` : `#${number} is nobody's now.`));
      return 0;
    }
    default:
      console.error(red(`cbx issue has no "${sub}". `) + "Try: view, comment, close, reopen, label, assign, labels, rules");
      return 1;
  }
}
