/**
 * This machine, as a project's Actions page shows it (backend machines.ts).
 *
 * Each machine gets a random id the first time cbx runs there, kept in its
 * settings folder, and is named after the computer. When cbx works in a
 * folder linked to a project, or on a draft handed to this machine, it says
 * so: which version it holds, which line it saves to, how many files it has
 * not saved. Only the folder's name goes, never its path.
 *
 * Saying so is best effort. It never delays a command by more than a moment,
 * never fails one, and is skipped when CODEROOK_NO_PRESENCE is set.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import path from "node:path";

import { clientHeaders } from "../../cbx/src/core/identify.js";
import { apiOrigin, configDirectory, loadToken } from "./config.js";

type Identity = { id: string; name: string };

let cached: Identity | null = null;

/** This machine's id and name, made once and kept. */
export async function machineIdentity(): Promise<Identity> {
  if (cached) return cached;
  const file = path.join(configDirectory(), "machine.json");
  let id = "";
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { id?: unknown };
    if (typeof saved.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(saved.id)) id = saved.id;
  } catch {
    /* First run on this machine, or the file was removed. */
  }
  if (!id) {
    id = randomBytes(12).toString("base64url");
    await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
    await writeFile(file, JSON.stringify({ id }, null, 2) + "\n").catch(() => undefined);
  }
  cached = { id, name: (process.env.CODEROOK_MACHINE_NAME || hostname() || "This machine").slice(0, 120) };
  return cached;
}

export type CheckIn = {
  kind: "folder" | "workspace";
  folder?: string;
  track?: string | null;
  baseVersionId?: string | null;
  changedFiles?: number | null;
  workspaceId?: string | null;
};

/** Tell the project this machine is here. Never throws, and gives up after a moment. */
export async function checkIn(repositoryId: string | undefined, state: CheckIn): Promise<void> {
  if (!repositoryId || process.env.CODEROOK_NO_PRESENCE) return;
  try {
    const token = await loadToken();
    if (!token) return;
    const me = await machineIdentity();
    const client = clientHeaders()["x-coderook-client"] ?? "";
    await fetch(`${apiOrigin()}/v1/repositories/${encodeURIComponent(repositoryId)}/machines`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...clientHeaders() },
      body: JSON.stringify({
        machineId: me.id,
        name: me.name,
        kind: state.kind,
        platform: `${platform()} ${release()}`.slice(0, 80),
        clientVersion: client.startsWith("cli/") ? client.slice(4) : null,
        folderName: state.folder ? path.basename(path.resolve(state.folder)) : null,
        track: state.track ?? null,
        baseVersionId: state.baseVersionId ?? null,
        changedFiles: state.changedFiles ?? null,
        workspaceId: state.workspaceId ?? null,
      }),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* Offline, signed out or slow: the command's own work is what matters. */
  }
}
