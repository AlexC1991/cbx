import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT = "33333333-3333-4333-8333-333333333333";
const usage = {
  usage: {
    includedCredits: 1400,
    usedCredits: 1400,
    reservedCredits: 0,
    remainingCredits: 0,
    purchasedCredits: 750,
    purchasedReservedCredits: 100,
    availablePurchasedCredits: 650,
    resetsAt: "2026-12-01T00:00:00.000Z",
    pr: {
      includedCredits: 1400,
      usedCredits: 1400,
      remainingCredits: 0,
      exhausted: true,
    },
  },
  canManage: false,
};

test("CLI and read-only MCP report separate allowances without changing billing; remote MCP preserves the server's result", async () => {
  const sent: string[] = [];
  let denied = false;
  const server = createServer(async (req, res) => {
    sent.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/repositories")
      return res.end(
        JSON.stringify({ repositories: [{ id: PROJECT, slug: "usage-demo" }] }),
      );
    if (req.url === `/v1/repositories/${PROJECT}`)
      return res.end(
        JSON.stringify({ id: PROJECT, slug: "usage-demo", ai: { read: true } }),
      );
    if (req.url === `/v1/repositories/${PROJECT}/workspace-usage`) {
      if (denied) {
        res.statusCode = 403;
        return res.end(
          JSON.stringify({
            error: {
              code: "members_only",
              message: "Only people on this project can see this",
            },
          }),
        );
      }
      return res.end(JSON.stringify(usage));
    }
    if (req.url === "/mcp" && req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const rpc = JSON.parse(text);
      assert.equal(rpc.params.name, "workspace_usage");
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(usage) }],
            isError: false,
          },
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const home = await mkdtemp(path.join(tmpdir(), "coderook-usage-"));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  function run(args: string[], input = "") {
    return new Promise<{ code: number | null; out: string; err: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.resolve("dist/cli/src/cli.js"), ...args],
          {
            cwd: home,
            env: {
              ...process.env,
              CODEROOK_API_URL: origin,
              CODEROOK_TOKEN: "fixture-token",
              CODEROOK_CONFIG_DIR: home,
              NO_COLOR: "1",
            },
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 30000,
          },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, out, err }));
        child.stdin.end(input);
      },
    );
  }
  try {
    const cli = await run(["workspace", "usage", "usage-demo"]);
    assert.equal(cli.code, 0, cli.err);
    assert.deepEqual(JSON.parse(cli.out), usage);
    const request = (name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { project: "usage-demo" } },
      }) + "\n";
    const local = await run(["mcp"], request("coderook_usage"));
    assert.equal(local.code, 0, local.err);
    assert.deepEqual(
      JSON.parse(JSON.parse(local.out).result.content[0].text),
      usage,
    );
    assert(
      sent.every((s) => s.startsWith("GET ")),
      sent.join("\n"),
    );
    denied = true;
    const refusal = JSON.parse(
      (await run(["mcp"], request("coderook_usage"))).out,
    );
    assert.equal(refusal.result.isError, true);
    assert.match(refusal.result.content[0].text, /Only people on this project/);
    const remote = await run(
      ["mcp", "--workspaces"],
      request("workspace_usage"),
    );
    assert.equal(remote.code, 0, remote.err);
    assert.deepEqual(
      JSON.parse(JSON.parse(remote.out).result.content[0].text),
      usage,
    );
    assert.deepEqual(
      sent.filter((s) => !s.startsWith("GET ")),
      ["POST /mcp"],
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    assert.equal(path.resolve(path.dirname(home)), path.resolve(tmpdir()));
    assert(path.basename(home).startsWith("coderook-usage-"));
    await rm(home, { recursive: true, force: true });
  }
});
