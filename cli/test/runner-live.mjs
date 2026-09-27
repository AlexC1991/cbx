/**
 * The whole of Actions, end to end, against the live service.
 *
 * Everything else that covers this covers one half. The backend suite proves
 * the queue hands a job to one machine and takes it back when that machine
 * disappears, with no runner involved. The website suite proves a button
 * exists and a dialog opens. Neither would notice if the agent could not
 * fetch a version, could not run a command, or reported its verdict to a
 * route that answers 404 — which is exactly the failure this feature had
 * before it was built: a button wired to nothing.
 *
 * So this presses the whole path. A real project, a real version with a real
 * file in it, a real workflow with a real command, queued through the same
 * route the website calls, taken by the actual built CLI running as a
 * separate process, and judged by asking the service what happened.
 *
 *   node test/runner-live.mjs --allow-production
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { apiOrigin, assertSafeTarget, autoClean, liveToken } from "./live.mjs";

assertSafeTarget();

const run = promisify(execFile);
const ENTRY = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");
const API = apiOrigin();
const token = liveToken();
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-coderook-client": "cli/0.9.0",
};

const slug = `runner-${Date.now().toString(36)}`;
const sweep = autoClean((one) => one === slug, null);

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}

async function api(method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      `${method} ${route} → ${response.status} ${parsed?.error?.message ?? text}`,
    );
  }
  return parsed;
}

console.log(`\nCodeRook Actions, end to end against ${API}`);

const project = await api("POST", "/v1/repositories", {
  slug,
  displayName: "Runner verification",
  description: "Temporary project created by the runner check",
  visibility: "private",
});

/*
  A version with something in it, because the runner fetches the version
  before it runs anything and a version with no files is refused. The command
  below reads this file back, so a runner that fetched nothing fails the check
  rather than passing it by doing nothing.
*/
const payload = Buffer.from("hello from the version\n", "utf8");
const sha256 = createHash("sha256").update(payload).digest("hex");
const stored = await fetch(
  `${API}/v1/repositories/${project.id}/objects/${sha256}?kind=chunk&role=chunk`,
  {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
      "content-length": String(payload.byteLength),
      "x-coderook-client": "cli/0.9.0",
    },
    body: payload,
  },
);
const object = await stored.json();
await api("POST", `/v1/repositories/${project.id}/versions`, {
  message: "The thing to run against",
  sourceSize: payload.byteLength,
  storedSize: payload.byteLength,
  files: [
    {
      path: "greeting.txt",
      objectId: object.objectId,
      sourceSize: payload.byteLength,
      storedSize: payload.byteLength,
      mediaType: "text/plain",
      executable: false,
    },
  ],
});

// A workflow with nothing to run must be refused rather than queued.
const empty = await api("POST", `/v1/repositories/${project.id}/workflows`, {
  name: "Nothing",
  trigger: "manual",
});
let refused = null;
try {
  await api("POST", `/v1/repositories/${project.id}/workflows/${empty.id}/runs`);
} catch (error) {
  refused = error.message;
}
record(
  "a workflow with no command cannot be queued",
  Boolean(refused && refused.includes("command")),
  refused ?? "it was queued",
);

const workflow = await api("POST", `/v1/repositories/${project.id}/workflows`, {
  name: "Read the file",
  trigger: "manual",
  /*
    Deliberately reads a file out of the fetched version. A runner that ran
    the command in an empty directory would exit non-zero, so "passed" cannot
    be reached without the fetch having genuinely worked.
  */
  command:
    process.platform === "win32"
      ? "type greeting.txt"
      : "cat greeting.txt",
});
record("a workflow can be created with a command", Boolean(workflow.id));

const queued = await api(
  "POST",
  `/v1/repositories/${project.id}/workflows/${workflow.id}/runs`,
);
record(
  "pressing run queues it rather than starting it",
  queued.status === "queued" && typeof queued.number === "number",
  JSON.stringify(queued),
);

const waiting = await api("GET", `/v1/repositories/${project.id}/workflows`);
record(
  "the queued run is waiting, claimed by nothing",
  waiting.runs?.[0]?.status === "queued" && waiting.runs?.[0]?.claimedBy === null,
  JSON.stringify(waiting.runs?.[0] ?? null),
);

// The actual agent, as a separate process, taking one job and stopping.
const agent = await run(
  process.execPath,
  [ENTRY, "runner", slug, "--once", "--name", "verification-box"],
  {
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", CODEROOK_TOKEN: token },
  },
).catch((error) => ({
  stdout: error.stdout ?? "",
  stderr: `${error.stderr ?? ""}\n${error.message}`,
}));
const output = `${agent.stdout}${agent.stderr}`;
record(
  "the runner takes the job and says it passed",
  /Passed in/.test(output),
  output.trim().split("\n").slice(-4).join("\n"),
);

const after = await api("GET", `/v1/repositories/${project.id}/workflows`);
const finished = after.runs?.[0];
record(
  "the service was told it passed",
  finished?.status === "passed",
  JSON.stringify(finished ?? null),
);
record(
  "and which machine did it",
  finished?.claimedBy === "verification-box",
  String(finished?.claimedBy),
);
record(
  "with a duration the runner measured",
  typeof finished?.durationMs === "number" && finished.durationMs >= 0,
  String(finished?.durationMs),
);

const logs = await api(
  "GET",
  `/v1/repositories/${project.id}/runs/${finished?.id}/logs`,
);
const printed = (logs.lines ?? []).map((one) => one.line).join("\n");
record(
  "the file from the version reached the log",
  printed.includes("hello from the version"),
  printed.slice(0, 200),
);

const machines = await api("GET", `/v1/repositories/${project.id}/runners`);
record(
  "the machine is listed, with what it is",
  machines.runners?.[0]?.name === "verification-box" &&
    Boolean(machines.runners?.[0]?.platform),
  JSON.stringify(machines.runners?.[0] ?? null),
);

// And an empty queue is a quiet answer rather than an error.
const idle = await run(
  process.execPath,
  [ENTRY, "runner", slug, "--once", "--name", "verification-box"],
  { env: { ...process.env, NO_COLOR: "1", CODEROOK_TOKEN: token } },
).catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
record(
  "an empty queue stops cleanly",
  /Nothing waiting/.test(`${idle.stdout}${idle.stderr}`),
  `${idle.stdout}${idle.stderr}`.trim(),
);

await sweep();

const failed = results.filter((one) => !one.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} checks passed against ${API}`,
);
console.log("throwaway project removed");
process.exitCode = failed ? 1 : 0;
