/**
 * cbx workspace review <project> <workspace> --ok [-m "…"] | --changes -m "…"
 * cbx workspace reviewers <project> [--data-file rules.json]
 *
 * The CLI side of the review gate (backend workspace_reviews.ts). A review
 * counts only from the reviewer's own sign-in or token, so --as is refused
 * here before the service refuses it, with the reason.
 */
import { readFile } from "node:fs/promises";
import { callApi } from "./api.js";
import { accent, bold, dim, green, red } from "./colour.js";
import type { Parsed } from "./registry.js";

export type ReviewerState = {
  reviewer: string;
  label: string;
  applies: boolean;
  state: "ok" | "changes" | "waiting" | "outdated";
  revision: number | null;
  note: string;
  beforeSave: boolean;
  beforeDeploy: boolean;
};

const flag = (parsed: Parsed, ...names: string[]) => {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
};

/** One line per reviewer: a word for where it stands, never only a colour. */
export function describeReviewer(s: ReviewerState, revision: number): string {
  const when = [s.beforeSave && "save", s.beforeDeploy && "deploy"].filter(Boolean).join(" + ");
  if (!s.applies) return `${dim("not needed")}  ${s.label} ${dim(`(no changes in its paths)`)}`;
  const word =
    s.state === "ok"
      ? green("OK        ")
      : s.state === "changes"
        ? red("changes   ")
        : s.state === "outdated"
          ? "outdated  "
          : dim("waiting   ");
  const detail =
    s.state === "outdated"
      ? `OK was for revision ${s.revision}, draft is at ${revision}`
      : s.state === "changes" || (s.state === "ok" && s.note)
        ? s.note
        : "";
  return `${word}${bold(s.label)} ${dim(`before ${when}`)}${detail ? `  ${detail}` : ""}`;
}

export async function commandWorkspaceReview(parsed: Parsed, root: string, workspace: string): Promise<number> {
  if (parsed.flags.has("as") || process.env.CBX_NAME)
    throw new Error("A review counts only from the reviewer's own sign-in or token; run it without --as or CBX_NAME.");
  const ok = parsed.flags.has("ok");
  const changes = parsed.flags.has("changes");
  const draft = `${root}/workspaces/${encodeURIComponent(workspace)}`;
  if (ok === changes) {
    /* Neither: show where the draft stands. */
    const shown = await callApi<{ workspace: { revision: number }; review?: ReviewerState[] }>(draft);
    const review = shown.review ?? [];
    if (parsed.flags.has("json")) console.log(JSON.stringify({ revision: shown.workspace.revision, review }, null, 2));
    else if (!review.length) console.log("This project names no reviewers. An administrator sets them with cbx workspace reviewers.");
    else for (const s of review) console.log(describeReviewer(s, shown.workspace.revision));
    return 0;
  }
  const note = flag(parsed, "m", "message") ?? "";
  if (changes && !note.trim()) throw new Error('Say what needs to change: --changes -m "…"');
  const revision = parsed.flags.has("revision")
    ? Number(parsed.flags.get("revision"))
    : (await callApi<{ workspace: { revision: number } }>(draft)).workspace.revision;
  const out = await callApi<{ review: ReviewerState[] }>(`${draft}/reviews`, {
    method: "POST",
    body: { verdict: ok ? "ok" : "changes", note, expectedRevision: revision },
  });
  if (parsed.flags.has("json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${ok ? green("OK") : red("Changes asked")} on revision ${revision}.`);
    for (const s of out.review) console.log(`  ${describeReviewer(s, revision)}`);
  }
  return 0;
}

export async function commandWorkspaceReviewers(parsed: Parsed, root: string): Promise<number> {
  const source = flag(parsed, "data-file");
  const rules = source
    ? (
        await callApi<{ rules: unknown[] }>(`${root}/workspace-review-rules`, {
          method: "PUT",
          body: { rules: JSON.parse(await readFile(source, "utf8")) },
        })
      ).rules
    : (await callApi<{ rules: unknown[] }>(`${root}/workspace-review-rules`)).rules;
  if (parsed.flags.has("json") || source) console.log(JSON.stringify({ rules }, null, 2));
  else if (!rules.length)
    console.log(
      `No reviewers. Set them from a JSON list with ${accent("cbx workspace reviewers <project> --data-file rules.json")}:\n` +
        dim('  [{"reviewer":"token:<id>","label":"UX Bot","paths":["website/"],"beforeSave":true,"beforeDeploy":false,"ownerMayOverride":false}]'),
    );
  else
    for (const r of rules as Array<{ label: string; reviewer: string; paths: string[]; beforeSave: boolean; beforeDeploy: boolean; ownerMayOverride: boolean }>)
      console.log(
        `${bold(r.label)} ${dim(r.reviewer)}  ${r.paths.length ? r.paths.join(", ") : "every path"}  ${dim(
          `before ${[r.beforeSave && "save", r.beforeDeploy && "deploy"].filter(Boolean).join(" + ")}${r.ownerMayOverride ? "; owner may go ahead without" : ""}`,
        )}`,
      );
  return 0;
}
