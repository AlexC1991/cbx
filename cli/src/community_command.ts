/**
 * `cbx fork`     — your own copy of somebody's project, and offering work back.
 * `cbx security` — private vulnerability reports.
 *
 *   cbx fork sam/editor [--name my-editor]      copy it into your account
 *   cbx fork offer [line] --title "…"           offer this fork's line to the original as a pull request
 *   cbx fork sync                               bring the original's latest into the "upstream" line
 *
 *   cbx security report sam/editor --title "…" [--severity high] [--body "…"]
 *   cbx security list | view S-3 | reply S-3 -m "…" | mark S-3 fixed
 *   cbx security policy [--on | --off] [--text <file or text>] [--clear]
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { callApi, findProject } from "./api.js";
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

export async function commandFork(parsed: Parsed): Promise<number> {
  const sub = parsed.positional[0] ?? "";
  if (sub === "offer" || sub === "sync") {
    const project = await resolveProject(flagText(parsed, "project"));
    if (!project) return 1;
    if (sub === "sync") {
      const result = await callApi<{ line: string; sequence: number }>(`/v1/repositories/${encodeURIComponent(project.id)}/sync-upstream`, { method: "POST" });
      console.log(`${green("Brought in.")} The original's latest is v${result.sequence} on the ${accent("upstream")} line.`);
      console.log(dim("  Merge it into yours when you are ready: cbx propose upstream, or on the website."));
      return 0;
    }
    const line = parsed.positional[1] ?? "main";
    const result = await callApi<{ line: string; pull: { reference: string }; updated: boolean }>(
      `/v1/repositories/${encodeURIComponent(project.id)}/upstream-pulls`,
      { method: "POST", body: { line, title: flagText(parsed, "title", "m", "message") ?? `Changes from ${line}`, body: flagText(parsed, "body") ?? null } },
    );
    console.log(
      result.updated
        ? `${green("Updated")} ${result.pull.reference} with your newest save on ${line}.`
        : `${green("Opened")} ${result.pull.reference} on the original, from ${result.line}.`,
    );
    console.log(dim("  Its runs there wait for the project's approval and get none of its secrets."));
    return 0;
  }
  const reference = sub;
  if (!reference || !reference.includes("/")) {
    console.error(red("Whose project? Try: cbx fork sam/editor   (or: cbx fork offer, cbx fork sync)"));
    return 1;
  }
  const source = await findProject(reference);
  if (!source) {
    console.error(red(`No project ${reference} that you can see.`));
    return 1;
  }
  const fork = await callApi<{ id: string; slug: string; sequence: number }>(`/v1/repositories/${encodeURIComponent(source.id)}/fork`, {
    method: "POST",
    body: flagText(parsed, "name") ? { slug: flagText(parsed, "name") } : {},
  });
  console.log(`${green("Forked")} ${reference} as ${bold(fork.slug)} (private, v${fork.sequence}).`);
  console.log(dim(`  Get it: cbx get ${fork.slug}   Offer changes back: cbx fork offer <line> --title "…"`));
  return 0;
}

type Report = {
  number: number;
  title: string;
  body: string;
  severity: string;
  state: string;
  reporter: string | null;
  createdAt: string;
  handler: boolean;
  comments: Array<{ body: string; author: string | null; createdAt: string }>;
};

export async function commandSecurity(parsed: Parsed): Promise<number> {
  const sub = parsed.positional[0] ?? "list";
  if (sub === "report") {
    const reference = parsed.positional[1];
    const target = reference ? await findProject(reference) : await resolveProject(flagText(parsed, "project"));
    if (!target) {
      console.error(red(reference ? `No project ${reference} that you can see.` : "Which project? cbx security report sam/editor --title \"…\""));
      return 1;
    }
    const title = flagText(parsed, "title", "m", "message");
    if (!title) {
      console.error(red('Say what is wrong: --title "Path traversal in export"'));
      return 1;
    }
    const created = await callApi<{ number: number }>(`/v1/repositories/${encodeURIComponent(target.id)}/security-reports`, {
      method: "POST",
      body: { title, body: flagText(parsed, "body") ?? "", severity: flagText(parsed, "severity") ?? "unknown" },
    });
    console.log(`${green("Sent privately")} as S-${created.number}. Only the project's owner and admins can read it; you hear when they reply.`);
    return 0;
  }
  const project = await resolveProject(flagText(parsed, "project"));
  if (!project) return 1;
  if (sub === "policy") return securityPolicy(parsed, project);
  const base = `/v1/repositories/${encodeURIComponent(project.id)}/security-reports`;
  if (sub === "list") {
    const { reports } = await callApi<{ reports: Array<{ number: number; title: string; severity: string; state: string; reporter: string | null }> }>(base);
    if (!reports.length) {
      console.log(dim(`No security reports on ${project.slug} that you can see.`));
      return 0;
    }
    for (const report of reports) {
      console.log(`  ${accent(`S-${report.number}`)} ${report.title} ${dim(`${report.severity} · ${report.state} · ${report.reporter ?? "?"}`)}`);
    }
    return 0;
  }
  const number = Number((parsed.positional[1] ?? "").replace(/^S-/i, ""));
  if (!Number.isInteger(number) || number < 1) {
    console.error(red(`Which report? cbx security ${sub} S-3`));
    return 1;
  }
  if (sub === "view") {
    const report = await callApi<Report>(`${base}/${number}`);
    console.log(`${bold(`S-${report.number} ${report.title}`)} ${dim(`${report.severity} · ${report.state} · from ${report.reporter ?? "?"}`)}`);
    console.log(report.body || dim("(no details)"));
    for (const comment of report.comments) console.log(`\n${accent(comment.author ?? "Somebody")} ${dim(new Date(comment.createdAt).toLocaleString())}\n${comment.body}`);
    return 0;
  }
  if (sub === "reply") {
    const body = flagText(parsed, "m", "message");
    if (!body) {
      console.error(red('Say something: cbx security reply S-3 -m "Confirmed, fixing"'));
      return 1;
    }
    await callApi(`${base}/${number}/comments`, { method: "POST", body: { body } });
    console.log(green(`Replied on S-${number}.`));
    return 0;
  }
  if (sub === "mark") {
    const state = parsed.positional[2];
    if (!state || !["open", "accepted", "fixed", "declined"].includes(state)) {
      console.error(red("Mark it open, accepted, fixed or declined: cbx security mark S-3 fixed"));
      return 1;
    }
    await callApi(`${base}/${number}`, { method: "PATCH", body: { state } });
    console.log(green(`S-${number} is ${state}. Whoever reported it is told.`));
    return 0;
  }
  console.error(red(`cbx security has no "${sub}". `) + "Try: report, list, view, reply, mark, policy");
  return 1;
}

/**
 * `cbx security policy` — whether the project takes private reports, and what
 * it tells people who want to send one. The website's Security section.
 *
 * --text takes a file when one by that name exists, because a policy is a
 * page of prose and nobody wants to type it as an argument; anything else is
 * used as the text itself.
 */
async function securityPolicy(parsed: Parsed, project: { id: string; slug: string; name: string }): Promise<number> {
  const route = `/v1/repositories/${encodeURIComponent(project.id)}/security-policy`;
  const on = parsed.flags.has("on");
  const off = parsed.flags.has("off");
  if (on && off) {
    console.error(red("Pick one: --on or --off."));
    return 1;
  }
  const change: { enabled?: boolean; policy?: string | null } = {};
  if (on || off) change.enabled = on;
  if (parsed.flags.has("clear")) change.policy = null;
  const given = parsed.flags.get("text");
  if (given !== undefined) {
    if (typeof given !== "string" || !given.trim()) {
      console.error(red("What should it say? --text SECURITY.md, or --text \"Email security@…\""));
      return 1;
    }
    const file = path.resolve(given);
    change.policy = existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : given;
  }
  if (Object.keys(change).length) {
    await callApi(route, { method: "PUT", body: change });
    console.log(green(`Saved ${project.name}'s security policy.`));
  }
  const policy = await callApi<{ enabled: boolean; policy: string | null }>(route);
  console.log(
    `${bold(project.name)} ${policy.enabled ? green("takes private vulnerability reports") : dim("does not take private vulnerability reports")}`,
  );
  if (policy.policy?.trim()) {
    console.log("");
    console.log(policy.policy.trim());
  } else {
    console.log(dim("  No reporting policy written. Add one: cbx security policy --text SECURITY.md"));
  }
  return 0;
}
