/**
 * Whether the unread-messages reminder is due after a command.
 *
 * Kept apart from workspace_threads.ts, which needs the API client, so the
 * quick status in bin.ts can ask without loading it: when the reminder is
 * due, status goes the long way and the reminder is shown exactly as before.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { configDirectory } from "./config.js";

export const REMIND_EVERY_MS = 5 * 60_000;

/** When the reminder last asked, at most every REMIND_EVERY_MS. */
export const reminderStamp = (): string => path.join(configDirectory(), "discussions-checked");

/** Only at a terminal, never for these commands, and at most every five minutes. */
export async function reminderDue(command: string): Promise<boolean> {
  if (!process.stdout.isTTY || process.env.CODEROOK_NO_REMINDERS) return false;
  if (["workspace", "sign-in", "sign-out", "help", "mcp"].includes(command)) return false;
  try {
    const last = Number((await readFile(reminderStamp(), "utf8")).trim());
    if (Date.now() - last < REMIND_EVERY_MS) return false;
  } catch {
    /* Never checked on this machine. */
  }
  return true;
}
