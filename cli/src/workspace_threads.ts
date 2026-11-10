/**
 * Workspace discussions in the terminal (approved concept, 2026-11-05).
 *
 *   cbx workspace                    at a terminal: choose a workspace, see what is
 *                                    being discussed, and act on it with one key
 *   cbx workspace say <p> <w> -m …   post to a workspace's thread (JSON)
 *   cbx workspace thread <p> <w>     read it (JSON); --unread, --peek
 *   cbx workspace mute|unmute <p> <w>
 *
 * A machine signed in to the account can name itself with --as or CBX_NAME, so
 * its messages read as its own ("GrokBot · your account") and it keeps its own
 * read point. A machine a draft was handed to is named by its handover already.
 *
 * Any other command ends with one line when something is unread (unreadReminder),
 * at most every few minutes and only at a terminal, so scripts never see it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { callApi } from "./api.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { configDirectory } from "./config.js";
import { reminderDue, reminderStamp } from "./reminder_gate.js";
import type { Parsed } from "./registry.js";
import { authorLabel, mentions, readerNames } from "./workspace_watch.js";

type Thread = {
  pinned: string;
  messages: Message[];
  unread: number;
  muted: boolean;
  next: string | null;
};
type Message = {
  id: string;
  kind: "message" | "event";
  body: string;
  author: { label: string; kind: "person" | "named" | "token"; mine: boolean };
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
};
type Listed = {
  id: string;
  name: string;
  projectId: string;
  project: string;
  owner: string | null;
  track: string;
  revision: number;
  activeAt: string;
  unread: number;
};

export const THREAD_OPERATIONS = new Set(["say", "thread", "mute", "unmute"]);

/** The name this machine posts and reads as, if it gave one. */
export function authorName(parsed: Parsed): string | undefined {
  const flag = parsed.flags.get("as");
  const name = typeof flag === "string" ? flag : process.env.CBX_NAME;
  return name?.trim() || undefined;
}

const asQuery = (name: string | undefined) => (name ? `as=${encodeURIComponent(name)}` : "");
const join = (...parts: string[]) => {
  const query = parts.filter(Boolean).join("&");
  return query ? `?${query}` : "";
};

/** say, thread, mute and unmute: plain JSON, like every other workspace operation. */
export async function commandWorkspaceThread(
  operation: string,
  root: string,
  workspaceId: string,
  parsed: Parsed,
): Promise<number> {
  const name = authorName(parsed);
  const base = `${root}/workspaces/${encodeURIComponent(workspaceId)}/messages`;
  let result: unknown;
  if (operation === "say") {
    const message = parsed.flags.get("message") ?? parsed.flags.get("m");
    if (typeof message !== "string" || !message.trim())
      throw new Error('Write the message with -m "…"');
    result = await callApi(base, { method: "POST", body: { body: message, ...(name ? { as: name } : {}) } });
  } else if (operation === "thread") {
    const after = parsed.flags.get("after");
    result = await callApi(
      base +
        join(
          asQuery(name),
          parsed.flags.has("unread") ? "unread=true" : "",
          parsed.flags.has("peek") ? "peek=true" : "",
          typeof after === "string" ? `after=${encodeURIComponent(after)}` : "",
        ),
    );
  } else {
    result = await callApi(`${base}/mute`, {
      method: "PUT",
      body: { muted: operation === "mute", ...(name ? { as: name } : {}) },
    });
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

/* ----------------------------------------------------------- the reminder */


/**
 * One line after a command when a workspace thread has unread messages. Only
 * at a terminal, at most every five minutes, never slower than 1.5 s, and
 * silent on any failure: it must not change what a command does or prints in
 * a script.
 */
export async function unreadReminder(command: string, parsed: Parsed): Promise<void> {
  if (!(await reminderDue(command))) return;
  const stamp = reminderStamp();
  try {
    await mkdir(path.dirname(stamp), { recursive: true });
    await writeFile(stamp, String(Date.now()));
    const found = await Promise.race([
      callApi<{ workspaces: Listed[] }>(`/v1/account/workspace-threads${join(asQuery(authorName(parsed)))}`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500).unref()),
    ]);
    const waiting = found?.workspaces.filter((w) => w.unread > 0) ?? [];
    if (!waiting.length) return;
    /*
      Messages addressed to this reader come first, with who sent them and
      how to answer: a teammate or an assistant asked by name should not have
      to find that in a count. Each is shown once; the count follows.
    */
    const addressed = await Promise.race([
      addressedTo(parsed, waiting.slice(0, 3)),
      new Promise<[]>((resolve) => setTimeout(() => resolve([]), 1500).unref()),
    ]);
    for (const one of addressed.slice(0, 2)) {
      console.log(
        `\n${accent("●")} ${bold("For you")} ${dim("in")} ${one.workspace.name} ${dim("from")} ${one.from}: ${one.snippet}` +
          `\n  ${dim(`cbx workspace thread ${one.workspace.project} ${one.workspace.id} --unread`)}`,
      );
    }
    const total = waiting.reduce((n, w) => n + w.unread, 0);
    const where = waiting.length === 1 ? `in ${waiting[0]!.name}` : `in ${waiting.length} workspaces`;
    console.log(`${addressed.length ? "" : "\n"}${accent("●")} ${bold(`${total} new message${total === 1 ? "" : "s"}`)} ${dim(where)} ${dim("· cbx workspace")}`);
  } catch {
    /* A reminder is never worth an error. */
  }
}

/**
 * Unread messages that name this reader (@name), not yet shown on this
 * machine. A machine answers to the name it runs as; a person to their
 * username and display name, read once a day and kept beside the config.
 */
async function addressedTo(
  parsed: Parsed,
  waiting: Listed[],
): Promise<Array<{ workspace: Listed; from: string; snippet: string }>> {
  const as = authorName(parsed);
  const names = as ? [as] : await cachedReaderNames();
  if (!names.length) return [];
  const shownFile = path.join(configDirectory(), "mentions-shown.json");
  const shown = new Set<string>(await readFile(shownFile, "utf8").then((t) => JSON.parse(t) as string[]).catch(() => []));
  const out: Array<{ workspace: Listed; from: string; snippet: string }> = [];
  for (const workspace of waiting) {
    const thread = await callApi<Thread>(
      `/v1/repositories/${encodeURIComponent(workspace.projectId)}/workspaces/${encodeURIComponent(workspace.id)}/messages${join(asQuery(as), "unread=true", "peek=true")}`,
    );
    for (const message of thread.messages) {
      if (message.kind !== "message" || message.author.mine || shown.has(message.id) || !mentions(message.body, names)) continue;
      shown.add(message.id);
      const text = message.body.replace(/\s+/g, " ").trim();
      out.push({ workspace, from: authorLabel(message.author), snippet: text.length > 140 ? `${text.slice(0, 139)}…` : text });
    }
  }
  if (out.length) await writeFile(shownFile, JSON.stringify([...shown].slice(-500))).catch(() => undefined);
  return out;
}

async function cachedReaderNames(): Promise<string[]> {
  const file = path.join(configDirectory(), "reader-names.json");
  try {
    const kept = JSON.parse(await readFile(file, "utf8")) as { at: number; names: string[] };
    if (Date.now() - kept.at < 86_400_000) return kept.names;
  } catch {
    /* Not read yet on this machine. */
  }
  const names = await readerNames();
  await writeFile(file, JSON.stringify({ at: Date.now(), names })).catch(() => undefined);
  return names;
}

/* ----------------------------------------------------------- the picker */

const when = (iso: string) => {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(today.valueOf() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return "yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));

function who(message: Message): string {
  const label = message.author.label;
  if (message.author.kind === "person") return accent("You");
  if (message.author.kind === "named") return `${bold(label)} ${dim("· your account")}`;
  return `${bold(label)} ${dim("· handed over by you")}`;
}

function renderMessage(message: Message): string {
  const time = dim(when(message.createdAt));
  if (message.kind === "event") return `  ${green("✓")} ${dim(message.body)} ${dim("·")} ${time}`;
  const body = message.deleted ? dim("(deleted)") : message.body.split("\n").map((line) => `    ${line}`).join("\n");
  return `  ${who(message)} ${dim("·")} ${time}${message.editedAt ? dim(" · edited") : ""}\n${body}`;
}

/** Read one key at a terminal. */
function key(): Promise<{ name: string; sequence: string; ctrl: boolean }> {
  return new Promise((resolve) => {
    const handler = (sequence: string, info: { name?: string; ctrl?: boolean }) => {
      process.stdin.off("keypress", handler);
      resolve({ name: info?.name ?? sequence, sequence, ctrl: Boolean(info?.ctrl) });
    };
    process.stdin.on("keypress", handler);
  });
}

/*
  A key, or nothing within `ms`. The views wait on this so they can look for
  new messages while somebody is reading, rather than only when a key is
  pressed: a thread that only updates on a keystroke reads as a dead one.
*/
function keyWithin(ms: number): Promise<{ name: string; sequence: string; ctrl: boolean } | null> {
  return new Promise((resolve) => {
    const handler = (sequence: string, info: { name?: string; ctrl?: boolean }) => {
      clearTimeout(timer);
      process.stdin.off("keypress", handler);
      resolve({ name: info?.name ?? sequence, sequence, ctrl: Boolean(info?.ctrl) });
    };
    const timer = setTimeout(() => {
      process.stdin.off("keypress", handler);
      resolve(null);
    }, ms);
    process.stdin.on("keypress", handler);
  });
}

const REFRESH_MS = 5000;

function raw(on: boolean) {
  if (process.stdin.isTTY) process.stdin.setRawMode(on);
  if (on) process.stdin.resume();
  else process.stdin.pause();
}

/** Ask for a line of text, out of raw mode. */
async function ask(prompt: string): Promise<string> {
  raw(false);
  const lines = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise<string>((resolve) => lines.question(prompt, resolve))).trim();
  } finally {
    lines.close();
  }
}

const clear = () => process.stdout.write("\x1b[2J\x1b[H");

/** `cbx workspace` on its own at a terminal. */
export async function interactiveWorkspaces(parsed: Parsed): Promise<number> {
  const name = authorName(parsed);
  readline.emitKeypressEvents(process.stdin);
  let selected = 0;
  let filter = "";
  try {
    for (;;) {
      const listed = await callApi<{ workspaces: Listed[]; archived: number }>(
        `/v1/account/workspace-threads${join(asQuery(name))}`,
      );
      const shown = listed.workspaces.filter((w) =>
        `${w.project} ${w.name}`.toLowerCase().includes(filter.toLowerCase()),
      );
      selected = Math.min(selected, Math.max(0, shown.length - 1));
      clear();
      console.log(
        `${dim("Open workspaces")}${name ? dim(`  as ${name}`) : ""}  ${dim("·  ↑↓ choose  ·  Enter open  ·  / filter  ·  q quit")}\n`,
      );
      if (!shown.length) console.log(dim(filter ? `  Nothing matches "${filter}".` : "  No open workspaces. Start one with cbx workspace open <project> --name …"));
      shown.forEach((w, index) => {
        const count = w.unread ? accent(pad(`${w.unread} new`, 7)) : dim(pad("read", 7));
        const line = ` ${index === selected ? accent("›") : " "} ${pad(w.project, 14)} ${pad(w.name, 40)} ${count} ${dim(when(w.activeAt))}`;
        console.log(index === selected ? bold(line) : line);
      });
      console.log(dim(`\n${shown.length} open${filter ? ` matching "${filter}"` : ""} · ${listed.archived} archived (cbx workspace list <project> shows them)`));
      raw(true);
      /* Redrawn only when something on it changed: new messages, or a workspace opened or closed. */
      const drawn = JSON.stringify(listed.workspaces.map((w) => [w.id, w.unread, w.activeAt]));
      let pressed: Awaited<ReturnType<typeof keyWithin>> = null;
      while (!pressed) {
        pressed = await keyWithin(REFRESH_MS);
        if (pressed) break;
        const now = await callApi<{ workspaces: Listed[] }>(`/v1/account/workspace-threads${join(asQuery(name))}`).catch(() => null);
        if (now && JSON.stringify(now.workspaces.map((w) => [w.id, w.unread, w.activeAt])) !== drawn) break;
      }
      if (!pressed) continue;
      if (pressed.ctrl && pressed.name === "c") return 0;
      if (pressed.name === "q" || pressed.name === "escape") return 0;
      if (pressed.name === "up") selected = Math.max(0, selected - 1);
      else if (pressed.name === "down") selected = Math.min(shown.length - 1, selected + 1);
      else if (pressed.sequence === "/") {
        filter = await ask("filter › ");
        selected = 0;
      } else if (pressed.name === "return" && shown[selected]) {
        const done = await openWorkspace(shown[selected]!, name);
        if (done) return 0;
      }
    }
  } finally {
    raw(false);
  }
}

type Shown = {
  workspace: { id: string; name: string; track: string; revision: number; note: string; archived: boolean; baseVersionId: string };
  changes: Array<{ path: string; removed: boolean }>;
  recipes: Array<{ name: string; kind: string }>;
};

/** One workspace: what changed, what is being said, and what to do. Returns true to leave cbx. */
async function openWorkspace(listed: Listed, name: string | undefined): Promise<boolean> {
  const root = `/v1/repositories/${encodeURIComponent(listed.projectId)}/workspaces/${encodeURIComponent(listed.id)}`;
  let notice = "";
  for (;;) {
    const shown = await callApi<Shown>(root);
    /* Every page, oldest first, so the newest messages are the ones shown (a page holds 50). */
    let thread = await callApi<Thread>(`${root}/messages${join(asQuery(name))}`);
    for (let more = 0; thread.next && more < 20; more += 1) {
      const page: Thread = await callApi<Thread>(`${root}/messages${join(asQuery(name), `after=${encodeURIComponent(thread.next)}`)}`);
      thread = { ...page, messages: [...thread.messages, ...page.messages] };
    }
    const w = shown.workspace;
    clear();
    console.log(`${bold(w.name)}  ${dim(`${listed.project} · ${w.track} · revision ${w.revision}${w.archived ? " · archived" : ""}`)}`);
    const files = shown.changes;
    console.log(
      files.length
        ? `${dim(`${files.length} file${files.length === 1 ? "" : "s"} changed`)}  ${dim(files.slice(0, 3).map((f) => f.path).join(" · "))}${files.length > 3 ? dim(" …") : ""}`
        : dim("No changes yet"),
    );
    if (thread.pinned) console.log(`\n${accent("PINNED")}  ${dim("handoff note")}\n  ${thread.pinned.split("\n").slice(0, 4).join("\n  ")}`);
    const recent = thread.messages.slice(-6);
    console.log(`\n${dim("Discussion")}${listed.unread ? `  ${accent(`${listed.unread} new`)}` : ""}${thread.muted ? dim("  · muted") : ""}`);
    console.log(recent.length ? recent.map(renderMessage).join("\n") : dim("  Nothing said yet. Press r to start."));
    if (thread.messages.length > recent.length || thread.next) console.log(dim("  … earlier messages: press t"));
    listed.unread = 0;
    console.log(dim("\n────────────────────────────────────────────────────────────"));
    console.log(
      ` ${accent("r")} reply   ${accent("t")} whole thread   ${accent("f")} files   ${accent("u")} run checks\n` +
        ` ${accent("s")} save as a version   ${accent("h")} hand over   ${accent("m")} ${thread.muted ? "unmute" : "mute"}   ${accent("c")} close   ${accent("q")} back`,
    );
    if (notice) console.log(`\n${notice}`);
    notice = "";
    raw(true);
    /* New messages appear on their own: a light check every few seconds, redrawn only when there is something new. */
    const newestAt = thread.messages[thread.messages.length - 1]?.createdAt ?? null;
    let pressed: Awaited<ReturnType<typeof keyWithin>> = null;
    while (!pressed) {
      pressed = await keyWithin(REFRESH_MS);
      if (pressed) break;
      const peek = await callApi<Thread>(
        `${root}/messages${join(asQuery(name), "peek=true", newestAt ? `after=${encodeURIComponent(newestAt)}` : "")}`,
      ).catch(() => null);
      if (peek && peek.messages.length) break;
    }
    if (!pressed) continue;
    if (pressed.ctrl && pressed.name === "c") return true;
    if (pressed.name === "q" || pressed.name === "escape") return false;
    try {
      if (pressed.name === "r") {
        const text = await ask(accent("reply › "));
        if (text) {
          await callApi(`${root}/messages`, { method: "POST", body: { body: text, ...(name ? { as: name } : {}) } });
          notice = green("Sent.");
        }
      } else if (pressed.name === "t") {
        await wholeThread(root, name);
      } else if (pressed.name === "f") {
        clear();
        console.log(bold(`${w.name} · changes`));
        console.log(files.length ? files.map((f) => `  ${f.removed ? red("removed") : green("changed")}  ${f.path}`).join("\n") : dim("  No changes yet"));
        await pause();
      } else if (pressed.name === "m") {
        await callApi(`${root}/messages/mute`, { method: "PUT", body: { muted: !thread.muted, ...(name ? { as: name } : {}) } });
        notice = green(thread.muted ? "Unmuted." : "Muted. New messages here no longer notify you.");
      } else if (pressed.name === "s") {
        const message = await ask("describe the version › ");
        if (message) {
          const saved = await callApi<{ version?: { sequence?: number }; review?: { line: string } }>(`${root}/save`, {
            method: "POST",
            body: { expectedRevision: w.revision, operationKey: `picker-${randomUUID()}`, message, ...(name ? { as: name } : {}) },
          });
          notice = green(`Saved${saved.version?.sequence ? ` as v${saved.version.sequence}` : ""}${saved.review ? ` on ${saved.review.line}, for review` : ""}.`);
        }
      } else if (pressed.name === "u") {
        const checks = shown.recipes.filter((one) => one.kind === "check");
        if (!checks.length) notice = dim("This project has no check recipes. cbx workspace recipe sets one up.");
        else {
          const pick = await ask(`recipe (${checks.map((one) => one.name).join(", ")}) › `);
          const recipe = checks.find((one) => one.name === pick) ?? (checks.length === 1 && !pick ? checks[0] : undefined);
          if (recipe) {
            const run = await callApi<{ runId?: string }>(`${root}/runs`, {
              method: "POST",
              body: { expectedRevision: w.revision, operationKey: `picker-${randomUUID()}`, recipe: recipe.name },
            });
            notice = green(`Started ${recipe.name}.`) + dim(run.runId ? ` cbx workspace logs ${listed.project} ${listed.id} ${run.runId}` : "");
          } else notice = dim("No such recipe; nothing started.");
        }
      } else if (pressed.name === "h") {
        const machine = await ask("machine name › ");
        if (machine) {
          const made = await callApi<{ token: string; assignment: { expiresAt: string | null } }>(`${root}/assignments`, {
            method: "POST",
            body: { name: machine },
          });
          clear();
          console.log(`${bold(`Handed to ${machine}`)}\n\n  ${made.token}\n\n${dim("Shown once. On that machine: cbx workspace checkout " + listed.project + " " + listed.id + " (with CODEROOK_TOKEN set to it).")}`);
          await pause();
        }
      } else if (pressed.name === "c") {
        const sure = await ask(`archive "${w.name}"? every machine it was handed to loses access (y/N) › `);
        if (sure.toLowerCase() === "y") {
          await callApi(root, { method: "PATCH", body: { expectedRevision: w.revision, archived: true } });
          return false;
        }
      }
    } catch (error) {
      notice = red(error instanceof Error ? error.message : String(error));
    }
  }
}

async function wholeThread(root: string, name: string | undefined): Promise<void> {
  clear();
  let after: string | null = null;
  do {
    const page: Thread = await callApi<Thread>(`${root}/messages${join(asQuery(name), after ? `after=${encodeURIComponent(after)}` : "")}`);
    if (!after && page.pinned) console.log(`${accent("PINNED")}  ${dim("handoff note")}\n  ${page.pinned.split("\n").join("\n  ")}\n`);
    for (const message of page.messages) console.log(renderMessage(message));
    after = page.next;
  } while (after);
  await pause();
}

async function pause(): Promise<void> {
  console.log(dim("\npress any key"));
  raw(true);
  await key();
}
