/**
 * `cbx pr` — a project's pull requests, from the command line.
 *
 * A pull request is a proposal: a line offered to another line (`cbx propose`
 * opens one). This is the rest of what the website's Pull requests tab does —
 * the list, one pull request's conversation, files and checks, commenting,
 * reviewing, labels, drafts, closing and reopening, and merging — so the work
 * can be reviewed without leaving the terminal.
 */
import { applyMerge, callApi, cancelMerge, requestReviews } from "./api.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";

type Summary = {
  id: string;
  reference: string;
  title: string;
  state: string;
  from: string | null;
  into: string | null;
  author: { username: string | null; displayName: string };
  createdAt: string;
  labels: Array<{ name: string }>;
  comments: number;
  checks: { passing: number; failing: number; pending: number; total: number };
  approvals: number;
  changesRequested: boolean;
  conflicts: number;
};

type Page = {
  id: string;
  reference: string;
  repositoryId: string;
  title: string;
  body: string | null;
  state: string;
  from: string;
  into: string;
  author: { username: string | null; displayName: string } | null;
  labels: Array<{ name: string }>;
  reviews: Array<{ reviewer: { username: string | null; displayName: string } | null; verdict: string; body: string | null; dismissed: boolean }>;
  requested: Array<{ reviewer: { username: string | null } | null; reviewed: boolean }>;
  checks: Array<{ name: string; state: string; required: boolean; detail: string | null }>;
  blockers: Array<{ kind: string; text: string }>;
  unresolvedThreads: number;
  linkedIssues: Array<{ number: number; title: string }>;
  comments: Array<{ id: string; author: { username: string | null; displayName: string }; body: string | null; path: string | null; line: number | null; replyTo: string | null; resolved: boolean; createdAt: string }>;
};

const flag = (parsed: Parsed, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
};

function who(person: { username: string | null; displayName: string } | null | undefined): string {
  if (!person) return "somebody";
  return person.username ? `@${person.username}` : person.displayName;
}

function stateWord(state: string): string {
  if (state === "open") return green("open");
  if (state === "merged") return accent("merged");
  if (state === "closed") return red("closed");
  return dim(state);
}

function checksWord(checks: Summary["checks"]): string {
  if (!checks.total) return "";
  if (checks.failing) return red(`✗ ${checks.failing} failing`);
  if (checks.pending) return accent(`● ${checks.pending} running`);
  return green(`✓ ${checks.passing} passing`);
}

/** The pull request a person named (M-3, or 3), on the project they named or this folder's. */
async function find(parsed: Parsed, at: number): Promise<{ id: string; reference: string; projectId: string } | null> {
  const wanted = parsed.positional[at];
  if (!wanted) {
    console.error(red("Which pull request? Name it like M-3."));
    return null;
  }
  const project = await resolveProject(flag(parsed, "project"));
  if (!project) return null;
  const reference = /^\d+$/.test(wanted) ? `M-${wanted}` : wanted.toUpperCase();
  const { pulls } = await callApi<{ pulls: Summary[] }>(`/v1/repositories/${project.id}/pulls?state=all`);
  const found = pulls.find((one) => one.reference.toUpperCase() === reference);
  if (!found) {
    console.error(red(`${project.name} has no pull request ${reference}.`));
    return null;
  }
  return { id: found.id, reference: found.reference, projectId: project.id };
}

async function list(parsed: Parsed): Promise<number> {
  const project = await resolveProject(parsed.positional[1] ?? flag(parsed, "project"));
  if (!project) return 1;
  const query = new URLSearchParams();
  const state = parsed.flags.has("all") ? "all" : (flag(parsed, "state") ?? "open");
  query.set("state", state);
  if (parsed.flags.has("mine")) query.set("review", "me");
  const label = flag(parsed, "label");
  if (label) query.set("label", label);
  const author = flag(parsed, "author");
  if (author) query.set("author", author);
  const { pulls, counts } = await callApi<{ pulls: Summary[]; counts: { open: number; merged: number; closed: number } }>(
    `/v1/repositories/${project.id}/pulls?${query}`,
  );
  console.log(`${bold(project.name)} ${dim(`· ${counts.open} open · ${counts.merged} merged · ${counts.closed} closed`)}`);
  if (!pulls.length) {
    console.log(dim(state === "open" ? "  No open pull requests. Offer a line with cbx propose." : "  Nothing here."));
    return 0;
  }
  for (const pull of pulls) {
    const flags = [
      checksWord(pull.checks),
      pull.conflicts ? accent(`${pull.conflicts} to settle`) : "",
      pull.changesRequested ? red("changes asked") : pull.approvals ? green(`${pull.approvals} approved`) : "",
      pull.comments ? dim(`${pull.comments} comment${pull.comments === 1 ? "" : "s"}`) : "",
      pull.labels.length ? dim(pull.labels.map((one) => one.name).join(", ")) : "",
    ].filter(Boolean);
    console.log(`  ${accent(pull.reference.padEnd(6))} ${stateWord(pull.state).padEnd(16)} ${pull.title}`);
    console.log(`         ${dim(`${pull.from} → ${pull.into} · ${who(pull.author)}`)}${flags.length ? `  ${flags.join("  ")}` : ""}`);
  }
  console.log("");
  console.log(dim("  Read one with: cbx pr view M-3"));
  return 0;
}

async function view(parsed: Parsed): Promise<number> {
  const found = await find(parsed, 1);
  if (!found) return 1;
  const pull = await callApi<Page>(`/v1/merge-tracks/${found.id}/pull`);
  console.log(`${accent(pull.reference)} ${bold(pull.title)}  ${stateWord(pull.state)}`);
  console.log(dim(`  ${who(pull.author)} wants to merge ${pull.from} into ${pull.into}`));
  if (pull.labels.length) console.log(dim(`  Labels: ${pull.labels.map((one) => one.name).join(", ")}`));
  if (pull.linkedIssues.length) console.log(dim(`  Closes: ${pull.linkedIssues.map((one) => `#${one.number}`).join(", ")}`));
  console.log("");
  console.log(pull.body?.trim() || dim("  No description."));
  console.log("");
  if (pull.reviews.length || pull.requested.length) {
    console.log(bold("Reviews"));
    for (const review of pull.reviews) {
      const verdict = review.dismissed
        ? accent("approval no longer counts")
        : review.verdict === "approve"
          ? green("approved")
          : review.verdict === "request_changes"
            ? red("asked for changes")
            : "commented";
      console.log(`  ${who(review.reviewer)} ${verdict}${review.body ? dim(` — ${review.body}`) : ""}`);
    }
    for (const asked of pull.requested.filter((one) => !one.reviewed)) {
      console.log(`  @${asked.reviewer?.username ?? "somebody"} ${dim("asked, not yet reviewed")}`);
    }
    console.log("");
  }
  if (pull.checks.length) {
    console.log(bold("Checks"));
    for (const check of pull.checks) {
      const mark = check.state === "passing" ? green("✓") : check.state === "failing" ? red("✗") : check.state === "skipped" ? dim("–") : accent("●");
      console.log(`  ${mark} ${check.name}${check.required ? dim(" (required)") : ""}${check.detail ? dim(` — ${check.detail}`) : ""}`);
    }
    console.log("");
  }
  const roots = pull.comments.filter((comment) => !comment.replyTo);
  if (roots.length) {
    console.log(bold("Conversation"));
    for (const root of roots) {
      const where = root.path ? dim(` on ${root.path}${root.line ? `:${root.line}` : ""}${root.resolved ? " (resolved)" : ""}`) : "";
      console.log(`  ${who(root.author)}${where}: ${root.body ?? dim("(deleted)")}`);
      for (const reply of pull.comments.filter((comment) => comment.replyTo === root.id)) {
        console.log(`    ${who(reply.author)}: ${reply.body ?? dim("(deleted)")}`);
      }
    }
    console.log("");
  }
  if (pull.state === "open" || pull.state === "draft") {
    if (pull.blockers.length) {
      console.log(bold(accent("Merging is blocked")));
      for (const blocker of pull.blockers) console.log(`  · ${blocker.text}`);
    } else {
      console.log(green("Ready to merge.") + dim(` cbx pr merge ${pull.reference}`));
    }
    if (pull.unresolvedThreads) console.log(dim(`  ${pull.unresolvedThreads} conversation(s) on lines not yet resolved.`));
  }
  return 0;
}

async function files(parsed: Parsed): Promise<number> {
  const found = await find(parsed, 1);
  if (!found) return 1;
  const answer = await callApi<{ files: Array<{ path: string; kind: string; viewed: boolean }> }>(`/v1/merge-tracks/${found.id}/files`);
  for (const file of answer.files) {
    const mark = file.kind === "added" ? green("A") : file.kind === "removed" ? red("D") : accent("M");
    console.log(`  ${mark} ${file.path}${file.viewed ? dim("  (viewed)") : ""}`);
  }
  console.log(dim(`  ${answer.files.length} file${answer.files.length === 1 ? "" : "s"} changed`));
  return 0;
}

async function comment(parsed: Parsed): Promise<number> {
  const found = await find(parsed, 1);
  if (!found) return 1;
  const body = flag(parsed, "message", "m") ?? parsed.positional.slice(2).join(" ");
  if (!body.trim()) {
    console.error(red('Say something: cbx pr comment M-3 -m "Looks good"'));
    return 1;
  }
  const at = flag(parsed, "line");
  const [path, line] = at ? [at.slice(0, at.lastIndexOf(":")), Number(at.slice(at.lastIndexOf(":") + 1))] : [undefined, undefined];
  await callApi(`/v1/merge-tracks/${found.id}/comments`, {
    method: "POST",
    body: { body, ...(path && line ? { path, line, side: "new" } : {}) },
  });
  console.log(`${green("Commented")} on ${found.reference}${path ? ` (${path}:${line})` : ""}.`);
  return 0;
}

async function review(parsed: Parsed, verdict: "approve" | "request_changes" | "comment"): Promise<number> {
  const found = await find(parsed, 1);
  if (!found) return 1;
  const body = flag(parsed, "message", "m");
  if (verdict === "request_changes" && !body) {
    console.error(red('Say what needs changing: cbx pr request-changes M-3 -m "…"'));
    return 1;
  }
  await callApi(`/v1/merge-tracks/${found.id}/review`, { method: "PUT", body: body ? { verdict, body } : { verdict } });
  console.log(`${verdict === "approve" ? green("Approved") : verdict === "request_changes" ? red("Asked for changes on") : "Reviewed"} ${found.reference}.`);
  return 0;
}

async function edit(parsed: Parsed, change: Record<string, unknown>, said: string): Promise<number> {
  const found = await find(parsed, 1);
  if (!found) return 1;
  await callApi(`/v1/merge-tracks/${found.id}/pull`, { method: "PATCH", body: change });
  console.log(`${found.reference} ${said}.`);
  return 0;
}

export async function commandPr(parsed: Parsed): Promise<number> {
  const sub = parsed.positional[0] ?? "list";
  switch (sub) {
    case "list":
      return list(parsed);
    case "view":
      return view(parsed);
    case "files":
      return files(parsed);
    case "comment":
      return comment(parsed);
    case "approve":
      return review(parsed, "approve");
    case "request-changes":
      return review(parsed, "request_changes");
    case "ready":
      return edit(parsed, { draft: false }, "is ready for review");
    case "draft":
      return edit(parsed, { draft: true }, "is a draft again");
    case "title": {
      const title = flag(parsed, "message", "m") ?? parsed.positional.slice(2).join(" ");
      if (!title.trim()) {
        console.error(red('Give the new title: cbx pr title M-3 "Better title"'));
        return 1;
      }
      return edit(parsed, { title }, "renamed");
    }
    case "retarget": {
      const into = parsed.positional[2];
      if (!into) {
        console.error(red("Into which line? cbx pr retarget M-3 release"));
        return 1;
      }
      return edit(parsed, { into }, `now lands on ${into}`);
    }
    case "label": {
      const found = await find(parsed, 1);
      if (!found) return 1;
      const labels = (parsed.positional[2] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
      const saved = await callApi<{ labels: string[] }>(`/v1/merge-tracks/${found.id}/labels`, { method: "PUT", body: { labels } });
      console.log(`${found.reference} labels: ${saved.labels.join(", ") || dim("none")}`);
      return 0;
    }
    case "ask": {
      const found = await find(parsed, 1);
      if (!found) return 1;
      const names = parsed.positional.slice(2).flatMap((one) => one.split(",")).map((one) => one.trim()).filter(Boolean);
      const asked = await requestReviews(found.id, names);
      console.log(`Asked ${asked.map((person) => person.displayName).join(", ") || "nobody new"} to review ${found.reference}.`);
      return 0;
    }
    case "close": {
      const found = await find(parsed, 1);
      if (!found) return 1;
      await cancelMerge(found.id);
      console.log(`${found.reference} closed without merging. The line and its saves are untouched.`);
      return 0;
    }
    case "reopen": {
      const found = await find(parsed, 1);
      if (!found) return 1;
      await callApi(`/v1/merge-tracks/${found.id}/reopen`, { method: "POST" });
      console.log(`${found.reference} reopened.`);
      return 0;
    }
    case "merge": {
      const found = await find(parsed, 1);
      if (!found) return 1;
      /* --squash lands it as one save, without the line's own saves in the target's history. */
      const result = parsed.flags.has("squash")
        ? await callApi<{ version: { sequence: number }; closedIssues?: number[] }>(
            `/v1/merge-tracks/${encodeURIComponent(found.id)}/apply?squash=true`,
            { method: "POST" },
          )
        : await applyMerge(found.id);
      console.log(
        `${green(parsed.flags.has("squash") ? "Squashed and merged" : "Merged")} ${found.reference} as version ${result.version.sequence}.` +
          (result.closedIssues?.length ? ` Closed ${result.closedIssues.map((n) => `#${n}`).join(", ")}.` : ""),
      );
      return 0;
    }
    case "auto-merge": {
      /* Merge by itself once nothing stands in the way (backend merge_rules.ts); --off stops it. */
      const found = await find(parsed, 1);
      if (!found) return 1;
      const enabled = !parsed.flags.has("off");
      await callApi(`/v1/merge-tracks/${encodeURIComponent(found.id)}/auto-merge`, {
        method: "PUT",
        body: { enabled, squash: parsed.flags.has("squash") },
      });
      console.log(
        enabled
          ? `${green("Set.")} ${found.reference} merges by itself once nothing stands in the way${parsed.flags.has("squash") ? ", squashed" : ""}.`
          : `${green("Off.")} ${found.reference} waits for somebody to merge it.`,
      );
      return 0;
    }
    default:
      console.error(red(`cbx pr has no "${sub}". `) + "See: " + accent("cbx help pr"));
      return 1;
  }
}
