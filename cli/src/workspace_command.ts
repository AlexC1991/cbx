import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ServiceError, callApi, findProject } from "./api.js";
import { apiOrigin, loadToken } from "./config.js";
import type { Parsed } from "./registry.js";
import { MACHINE_OPERATIONS, commandWorkspaceMachine } from "./workspace_machine.js";
import { THREAD_OPERATIONS, authorName, commandWorkspaceThread, interactiveWorkspaces } from "./workspace_threads.js";
import { commandWorkspacePut } from "./workspace_put.js";
import { commandWorkspaceReview, commandWorkspaceReviewers } from "./workspace_review.js";
import { commandWorkspaceStarter } from "./workspace_starter.js";
import { commandWorkspaceWatch } from "./workspace_watch.js";

export async function commandWorkspace(parsed: Parsed): Promise<number> {
  const [operation, projectRef, workspace, runId] = parsed.positional;
  if (operation && MACHINE_OPERATIONS.has(operation)) return commandWorkspaceMachine(parsed);
  /* On its own at a terminal: choose a workspace and see what is being discussed. Scripts get the usage line as before. */
  if (!operation && process.stdin.isTTY && process.stdout.isTTY) return interactiveWorkspaces(parsed);
  /* Every draft you can read when no project is named. */
  if (operation === "watch") return commandWorkspaceWatch(parsed);
  if (!operation || !projectRef)
    throw new Error(
      "Use cbx workspace <operation> <project> [workspace]. See cbx help workspace.",
    );
  const project = await findProject(projectRef);
  if (!project) throw new Error(`No accessible project ${projectRef}`);
  const root = `/v1/repositories/${encodeURIComponent(project.id)}`;
  if (operation === "starter") return commandWorkspaceStarter(parsed, root);
  if (operation === "reviewers") return commandWorkspaceReviewers(parsed, root);
  if (operation === "review") {
    if (!workspace) throw new Error("Supply the workspace ID after the project");
    return commandWorkspaceReview(parsed, root, workspace);
  }
  if (operation === "put") {
    if (!workspace) throw new Error("Supply the workspace ID after the project");
    return commandWorkspacePut(parsed, root, workspace);
  }
  if (THREAD_OPERATIONS.has(operation)) {
    if (!workspace) throw new Error("Supply the workspace ID after the project");
    return commandWorkspaceThread(operation, root, workspace, parsed);
  }
  const named = authorName(parsed);
  const flag = (name: string) => {
    const value = parsed.flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const integer = (name: string) => {
    const value = flag(name);
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error(`${name} must be a non-negative integer`);
    return n;
  };
  let data: Record<string, unknown> = {};
  const source = flag("data-file");
  if (source) {
    const raw = JSON.parse(await readFile(source, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("The data file must contain a JSON object");
    data = raw;
  }
  const key = flag("key") ?? data.operationKey;
  const revision = integer("revision") ?? data.expectedRevision;
  let path = `${root}/workspaces`,
    method = "GET",
    body: unknown;
  if (operation === "list") {
    if (named) path += `?as=${encodeURIComponent(named)}`;
  } else if (operation === "usage") {
    path = `${root}/workspace-usage`;
  } else if (operation === "open") {
    method = "POST";
    body = {
      ...data,
      name: flag("name") ?? data.name,
      track: flag("track") ?? data.track,
      baseVersionId: flag("base-version") ?? data.baseVersionId,
      operationKey: key,
    };
  } else if (operation === "recipe") {
    if (!workspace) throw new Error("Name the recipe after the project");
    path = `${root}/workspace-recipes/${encodeURIComponent(workspace)}`;
    method = "PUT";
    body = data;
  } else if (operation !== "list") {
    if (!workspace)
      throw new Error(
        "Supply the remote workspace ID; this command does not use a local project folder",
      );
    path += `/${encodeURIComponent(workspace)}`;
    if (operation === "read" || operation === "files") {
      const q = new URLSearchParams();
      for (const [name, value] of Object.entries({
        path: flag("path"),
        revision: integer("revision"),
        startLine: integer("start-line"),
        lines: integer("lines"),
        offset: integer("offset"),
      }))
        if (value !== undefined) q.set(name, String(value));
      path += `/files?${q}`;
    } else if (operation === "search")
      path += `/search?${new URLSearchParams({ q: flag("query") ?? "", offset: String(integer("offset") ?? 0) })}`;
    else if (operation === "diff")
      path += `/diff?offset=${integer("offset") ?? 0}`;
    else if (operation === "patch") {
      path += "/changes";
      method = "POST";
      body = { ...data, operationKey: key, expectedRevision: revision };
    } else if (operation === "save") {
      path += "/save";
      method = "POST";
      body = {
        ...data,
        operationKey: key,
        expectedRevision: revision,
        message: flag("message") ?? flag("m") ?? data.message,
        ...(named ? { as: named } : {}),
      };
    } else if (
      operation === "run" ||
      operation === "deploy" ||
      operation === "preview"
    ) {
      path += "/runs";
      method = "POST";
      body = {
        ...data,
        operationKey: key,
        expectedRevision: revision,
        recipe: flag("recipe") ?? data.recipe,
        ...(operation === "deploy"
          ? {
              target: flag("target") ?? data.target,
              savedVersionId: flag("version") ?? data.savedVersionId,
            }
          : {}),
      };
    } else if (
      operation === "logs" ||
      operation === "runs" ||
      operation === "cancel"
    ) {
      if (!runId) throw new Error("Supply the job ID after the workspace ID");
      path += `/runs/${encodeURIComponent(runId)}`;
      if (operation === "cancel") {
        path += "/cancel";
        method = "POST";
        body = {};
      }
    } else if (operation === "handoff" || operation === "close") {
      method = "PATCH";
      body = {
        ...data,
        expectedRevision: revision,
        note: flag("note") ?? data.note,
        ...(operation === "close" ? { archived: true } : {}),
      };
    } else if (operation !== "show")
      throw new Error(`Unknown workspace operation ${operation}`);
  }
  let result: unknown;
  try {
    result = await callApi(path, {
      method,
      ...(body === undefined ? {} : { body }),
    });
  } catch (error) {
    /*
      Saves land one at a time, each on top of whatever landed before, so the
      version a save made can differ from the draft that was checked: other
      people's work landed in between. That version is the one to check and
      ship, so check it where it is and deploy it, rather than refusing.
    */
    if (operation === "deploy" && error instanceof ServiceError && error.code === "workspace_saved_content_changed") {
      result = await deployLanded(root, body as DeployBody);
    } else throw error;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

type DeployBody = { operationKey?: unknown; recipe?: unknown; target?: unknown; savedVersionId?: unknown };
const say = (line: string) => process.stderr.write(line + "\n");
const FINISHED = new Set(["passed", "failed", "cancelled", "canceled", "timed_out", "error", "skipped"]);

/** Check a saved version where it landed, in an unedited draft on it, then deploy it. */
export async function deployLanded(
  root: string,
  body: DeployBody,
  options: { api?: typeof callApi; wait?: (ms: number) => Promise<void>; deadlineMs?: number } = {},
): Promise<unknown> {
  const api = options.api ?? callApi;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const saved = String(body.savedVersionId ?? "");
  const recipe = String(body.recipe ?? "");
  say(`That version merged onto the line after this draft was checked. Checking the version itself, then deploying it.`);
  const opened = await api<{ workspace: { id: string; revision: number } }>(`${root}/workspaces`, {
    method: "POST",
    body: { name: `Deploy ${saved.slice(0, 8)} (${recipe})`, operationKey: `deploy-landed-${saved}-${recipe}`, baseVersionId: saved },
  });
  const ws = `${root}/workspaces/${opened.workspace.id}`;
  if (opened.workspace.revision !== 0) throw new Error(`Draft ${opened.workspace.id} was edited; open a fresh one on the saved version.`);
  const shown = await api<{ recipes?: Array<{ name: string; required_recipes?: string[] }> }>(ws);
  const required = shown.recipes?.find((r) => r.name === recipe)?.required_recipes ?? [];
  const deadline = Date.now() + (options.deadlineMs ?? 45 * 60_000);
  for (const name of required) {
    const started = await api<{ runId: string; number?: number }>(`${ws}/runs`, {
      method: "POST",
      body: { expectedRevision: 0, operationKey: `check-${saved}-${name}`, recipe: name },
    });
    say(`  ${name}: run #${started.number ?? started.runId} on the saved version…`);
    for (;;) {
      /* The job endpoint answers { run: { status, number, … }, logs, artifacts }. */
      const answer = await api<{ run?: { status: string; number?: number } }>(`${ws}/runs/${started.runId}`);
      const run = answer.run ?? { status: "unknown" };
      if (run.status === "passed") {
        say(`  ${name}: passed`);
        break;
      }
      if (FINISHED.has(run.status) || run.status === "unknown") throw new Error(`${name} ${run.status} on the saved version (run #${run.number ?? started.runId}); not deploying.`);
      if (Date.now() > deadline) throw new Error(`${name} has not finished; deploy again later with the same command.`);
      await wait(15_000);
    }
  }
  return api(`${ws}/runs`, {
    method: "POST",
    body: {
      expectedRevision: 0,
      operationKey: `${String(body.operationKey ?? "deploy")}-landed`,
      recipe,
      target: body.target,
      savedVersionId: saved,
    },
  });
}

/** Explicit remote/write-capable alternative; the original cbx mcp stays read-only. */
export async function commandWorkspaceMcp(): Promise<number> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Record<string, unknown>;
    try {
      if (Buffer.byteLength(line) > 2 * 1024 * 1024)
        throw new Error("MCP request exceeds 2 MiB");
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid or oversized JSON request" },
        }) + "\n",
      );
      continue;
    }
    try {
      const token = await loadToken();
      if (!token)
        throw new Error(
          "Sign in with cbx sign-in before using remote workspace tools",
        );
      const response = await fetch(`${apiOrigin()}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: line,
        signal: AbortSignal.timeout(180000),
      });
      if (response.status === 202) continue;
      const output = await response.json();
      if (!response.ok && request.id !== undefined)
        throw new Error(
          "CodeRook refused the MCP connection; check sign-in and workspace scopes",
        );
      process.stdout.write(JSON.stringify(output) + "\n");
    } catch (error) {
      if (request.id !== undefined)
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32001,
              message:
                error instanceof Error
                  ? error.message
                  : "Remote workspace request failed",
            },
          }) + "\n",
        );
    }
  }
  return 0;
}
