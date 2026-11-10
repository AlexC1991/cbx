/**
 * cbx workspace watch [project] [workspace]
 *
 * What a person or an assistant working on drafts needs to hear about, as it
 * happens: new messages in the threads it can read, messages addressed to it
 * (@mentions), and new saved versions. One line per event until stopped,
 * plain text at a terminal or JSON lines with --json for a program to read.
 *
 * Built so neither a teammate nor an assistant has to write its own poller.
 * It reads with peek, so watching never marks anything read: the reader still
 * sees the thread as unread when it opens it.
 */
import { callApi, findProject, whoami } from "./api.js";
import { accent, bold, dim } from "./colour.js";
import type { Parsed } from "./registry.js";
import { authorName } from "./workspace_threads.js";

export type WatchMessage = {
  id: string;
  kind: "message" | "event";
  body: string;
  author: { label: string; kind: "person" | "named" | "token"; mine: boolean };
  createdAt: string;
};
export type WatchDraft = { id: string; name: string; projectId: string; project: string; unread: number };
export type WatchVersion = { id?: string; sequence: number | string; message?: string | null };
type Where = { project: string; projectId: string; workspace: string; workspaceName: string; id: string; at: string };
export type WatchEvent =
  | ({ type: "message" | "mention"; author: WatchMessage["author"]; body: string } & Where)
  | ({ type: "event"; body: string } & Where)
  | { type: "save"; project: string; projectId: string; sequence: number; message: string };

export type WatchState = {
  seen: Set<string>;
  /** Newest saved version seen per project; absent until the first look, so the past is not replayed. */
  newest: Map<string, number>;
  /** Messages older than this are history, not news. */
  since: number;
};

type Names = string | readonly (string | undefined | null)[] | undefined;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a message names this reader as @name, as a whole word (the same
 * rule the bell uses). A reader can answer to several names: the one a
 * machine runs as, or a person's username and display name.
 */
export function mentions(body: string, names: Names): boolean {
  const list = (typeof names === "string" ? [names] : names ?? [])
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
  return list.some((name) =>
    new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "iu").test(body),
  );
}

/** The events in one look that have not been reported, oldest first; updates state. */
export function freshEvents(state: WatchState, draft: WatchDraft, messages: readonly WatchMessage[], names: Names): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (const m of [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (state.seen.has(m.id)) continue;
    state.seen.add(m.id);
    if (Date.parse(m.createdAt) < state.since || m.author.mine) continue;
    const where: Where = { project: draft.project, projectId: draft.projectId, workspace: draft.id, workspaceName: draft.name, id: m.id, at: m.createdAt };
    if (m.kind === "event") out.push({ type: "event", ...where, body: m.body });
    else out.push({ type: mentions(m.body, names) ? "mention" : "message", ...where, author: m.author, body: m.body });
  }
  return out;
}

/** New saved versions since the last look; the first look only records where things stand. */
export function freshSaves(state: WatchState, project: { id: string; name: string }, versions: readonly WatchVersion[]): WatchEvent[] {
  const numbers = versions
    .map((v) => ({ sequence: Number(v.sequence), message: v.message ?? "" }))
    .filter((v) => Number.isFinite(v.sequence));
  const top = numbers.reduce((max, v) => Math.max(max, v.sequence), 0);
  const before = state.newest.get(project.id);
  state.newest.set(project.id, Math.max(before ?? 0, top));
  if (before === undefined) return [];
  return numbers
    .filter((v) => v.sequence > before)
    .sort((a, b) => a.sequence - b.sequence)
    .map((v) => ({ type: "save" as const, project: project.name, projectId: project.id, sequence: v.sequence, message: v.message }));
}

const flat = (text: string, most: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > most ? `${one.slice(0, most - 1)}…` : one;
};

/** Who wrote it, and how sure the service is: a person on the site, a machine on its own token, or a typed name. */
export function authorLabel(author: WatchMessage["author"]): string {
  if (author.kind === "person") return `${author.label} (site)`;
  if (author.kind === "token") return `${author.label} (own token)`;
  return `${author.label} (named, not verified)`;
}

export function describe(event: WatchEvent): string {
  if (event.type === "save") return `${accent("save")}     ${event.project} v${event.sequence}  ${flat(event.message, 160)}`;
  if (event.type === "event") return `${dim("event")}    ${event.workspaceName}  ${flat(event.body, 160)}`;
  const label = event.type === "mention" ? bold("for you ") : "message ";
  return `${label} ${event.workspaceName}  ${authorLabel(event.author)}: ${flat(event.body, 200)}  ${dim(event.workspace)}`;
}

/** The names a person signed in here answers to; empty when that cannot be read. */
export async function readerNames(): Promise<string[]> {
  try {
    const me = (await whoami()) as { username?: string | null; displayName?: string | null };
    return [me.username, me.displayName].filter((name): name is string => Boolean(name?.trim()));
  } catch {
    return [];
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function commandWorkspaceWatch(parsed: Parsed): Promise<number> {
  const [, projectRef, workspaceId] = parsed.positional;
  const name = authorName(parsed);
  const json = parsed.flags.has("json");
  const every = Math.max(5, Number(parsed.flags.get("interval") ?? 20) || 20) * 1000;
  const project = projectRef ? await findProject(projectRef) : null;
  if (projectRef && !project) throw new Error(`No accessible project ${projectRef}`);
  const as = name ? `as=${encodeURIComponent(name)}` : "";
  /* A machine answers to the name it runs as; a person to their own username and display name. */
  const names = name ? [name] : await readerNames();
  const state: WatchState = {
    seen: new Set(),
    newest: new Map(),
    since: parsed.flags.has("unread") ? 0 : Date.now() - 60_000,
  };
  const emit = (event: WatchEvent) => console.log(json ? JSON.stringify(event) : describe(event));
  if (!json && process.stdout.isTTY)
    console.error(
      dim(
        `Watching ${workspaceId ? "one draft" : project ? project.name : "every draft you can read"}` +
          `${names.length ? `, messages for @${names[0]} first` : ""}. Stop with Ctrl+C.`,
      ),
    );

  let stopped = false;
  process.once("SIGINT", () => {
    stopped = true;
  });
  let failures = 0;
  while (!stopped) {
    try {
      const listed = await callApi<{ workspaces?: WatchDraft[] }>(`/v1/account/workspace-threads${as ? `?${as}` : ""}`);
      const drafts = (listed.workspaces ?? []).filter(
        (w) => (!project || w.projectId === project.id) && (!workspaceId || w.id === workspaceId || w.id.startsWith(workspaceId)),
      );
      for (const draft of drafts) {
        if (!draft.unread) continue;
        const query = [as, "unread=true", "peek=true"].filter(Boolean).join("&");
        const thread = await callApi<{ messages?: WatchMessage[] }>(
          `/v1/repositories/${encodeURIComponent(draft.projectId)}/workspaces/${encodeURIComponent(draft.id)}/messages?${query}`,
        );
        const events = freshEvents(state, draft, thread.messages ?? [], names);
        /* Messages addressed to this reader first: they are the ones it is being asked to act on. */
        for (const event of [...events.filter((e) => e.type === "mention"), ...events.filter((e) => e.type !== "mention")]) emit(event);
      }
      const projects = project
        ? [{ id: project.id, name: project.name }]
        : [...new Map(drafts.map((d) => [d.projectId, { id: d.projectId, name: d.project }])).values()];
      for (const one of projects) {
        const versions = await callApi<{ versions?: WatchVersion[] }>(`/v1/repositories/${encodeURIComponent(one.id)}/versions`);
        for (const event of freshSaves(state, one, versions.versions ?? [])) emit(event);
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      console.error(`watch: ${error instanceof Error ? error.message : String(error)}${failures > 1 ? ` (${failures} in a row)` : ""}`);
    }
    /* Backs off while the service is unreachable, up to five minutes, and returns to the interval on success. */
    const pause = Math.min(300_000, every * 2 ** Math.min(failures, 4));
    for (let left = pause; left > 0 && !stopped; left -= 500) await wait(Math.min(500, left));
  }
  return 0;
}
