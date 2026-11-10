import assert from "node:assert/strict";
import test from "node:test";

import { deployLanded } from "../dist/cli/src/workspace_command.js";

/**
 * Deploying a save that landed behind somebody else's: the saved version is
 * checked where it is, in an unedited draft opened on it, and deployed only
 * once every required check has passed there.
 */

const root = "/v1/repositories/p";
const body = { operationKey: "go-1", recipe: "website-production", target: "coderook-web", savedVersionId: "v290-id" };

function fakeApi(checkStatuses: string[], revision = 0) {
  const calls: Array<{ route: string; method: string; body?: any }> = [];
  let polls = 0;
  const api = async (route: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ route, method, body: options.body });
    if (route === `${root}/workspaces` && method === "POST") return { workspace: { id: "d1", revision } };
    if (route === `${root}/workspaces/d1` && method === "GET")
      return { recipes: [{ name: "website-production", required_recipes: ["website-check"] }, { name: "website-check", required_recipes: [] }] };
    if (route === `${root}/workspaces/d1/runs` && method === "POST") {
      return (options.body as any).recipe === "website-check" ? { runId: "r-check", number: 180 } : { runId: "r-deploy", number: 181 };
    }
    // The real shape (remote_workspace_routes.ts): the job is under "run".
    if (route === `${root}/workspaces/d1/runs/r-check`) return { run: { status: checkStatuses[Math.min(polls++, checkStatuses.length - 1)], number: 180 }, logs: [], artifacts: [] };
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { api: api as any, calls };
}
const noWait = async () => undefined;

test("opens a draft on the saved version, waits for its check to pass, then deploys that version", async () => {
  const fake = fakeApi(["queued", "running", "passed"]);
  const result: any = await deployLanded(root, body, { api: fake.api, wait: noWait });
  assert.equal(result.runId, "r-deploy");
  const open = fake.calls[0]!;
  assert.equal(open.body.baseVersionId, "v290-id");
  const deploy = fake.calls.at(-1)!;
  assert.deepEqual(deploy.body, { expectedRevision: 0, operationKey: "go-1-landed", recipe: "website-production", target: "coderook-web", savedVersionId: "v290-id" });
  assert.equal(fake.calls.filter((c) => c.route.endsWith("/runs/r-check")).length, 3);
});

test("a failing check on the saved version stops the deploy", async () => {
  const fake = fakeApi(["running", "failed"]);
  await assert.rejects(deployLanded(root, body, { api: fake.api, wait: noWait }), /website-check failed on the saved version/);
  assert.equal(fake.calls.some((c) => c.method === "POST" && c.body?.recipe === "website-production"), false);
});

test("a reused draft that was edited is refused, not deployed", async () => {
  const fake = fakeApi(["passed"], 2);
  await assert.rejects(deployLanded(root, body, { api: fake.api, wait: noWait }), /was edited/);
  assert.equal(fake.calls.length, 1);
});
