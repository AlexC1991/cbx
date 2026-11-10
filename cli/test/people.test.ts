import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `cbx people`: inviting somebody, and joining from the other end.
 *
 * Runs the real binary against a stand-in service, so what is checked is the
 * request that was actually sent. The service accepts three roles; the CLI's
 * old default ("member") was none of them, so every plain invite failed.
 */

const PROJECT = "7a1c9e44-2b3d-4f5a-8c6e-1d2f3a4b5c6d";
const LINK = "https://coderook.com/?invite=tok_abc123";

type Sent = { method: string; url: string; body: unknown };

async function service() {
  const sent: Sent[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    sent.push({ method: request.method ?? "", url: request.url ?? "", body });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/repositories" && request.method === "GET") {
      return reply(200, {
        repositories: [{ id: PROJECT, slug: "night-owl-diner", displayName: "night-owl-diner" }],
      });
    }
    if (request.url === `/v1/repositories/${PROJECT}/invites` && request.method === "POST") {
      const role = (body as { role: string }).role;
      if (!["admin", "write", "read"].includes(role)) {
        return reply(400, { error: { message: "Invalid role" } });
      }
      return reply(201, { id: "i1", email: (body as { email: string }).email, role, inviteUrl: LINK });
    }
    if (request.url === "/v1/invites/accept" && request.method === "POST") {
      return reply(200, { repositoryId: PROJECT, role: "write" });
    }
    return reply(404, { error: { message: "not here" } });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as { port: number }).port;
  return {
    sent,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const home = mkdtempSync(path.join(tmpdir(), "coderook-people-"));
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/* Asynchronous, so the stand-in service can answer while it waits. */
function run(origin: string, args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      [path.resolve("dist/cli/src/cli.js"), "people", ...args],
      {
        cwd: home,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CODEROOK_API_URL: origin,
          CODEROOK_TOKEN: "test-token",
          CODEROOK_CONFIG_DIR: home,
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) =>
        done({
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
          out: plain(String(stdout)),
          err: plain(String(stderr)),
        }),
    );
  });
}

const posts = (sent: Sent[], url: string) =>
  sent.filter((one) => one.method === "POST" && one.url === url).map((one) => one.body);

test("an invite with no --role asks for write, and hands back the link", async () => {
  const api = await service();
  try {
    const result = await run(api.origin, ["night-owl-diner", "--invite", "sam@example.com"]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(posts(api.sent, `/v1/repositories/${PROJECT}/invites`), [
      { email: "sam@example.com", role: "write" },
    ]);
    assert.match(result.out, /Invited sam@example\.com to night-owl-diner\./);
    assert.ok(result.out.includes(LINK), result.out);
  } finally {
    await api.close();
  }
});

test("a role the service doesn't have is refused here, and nothing is sent", async () => {
  const api = await service();
  try {
    const result = await run(api.origin, ["night-owl-diner", "--invite", "sam@example.com", "--role", "member"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /not a role/);
    assert.equal(posts(api.sent, `/v1/repositories/${PROJECT}/invites`).length, 0);
  } finally {
    await api.close();
  }
});

test("--accept sends the token from the link, whole link or bare token", async () => {
  const api = await service();
  try {
    const fromLink = await run(api.origin, ["--accept", LINK]);
    assert.equal(fromLink.code, 0, fromLink.err);
    assert.match(fromLink.out, /joined the project as write/);
    const fromToken = await run(api.origin, ["--accept", "tok_abc123"]);
    assert.equal(fromToken.code, 0, fromToken.err);
    assert.deepEqual(posts(api.sent, "/v1/invites/accept"), [
      { token: "tok_abc123" },
      { token: "tok_abc123" },
    ]);
  } finally {
    await api.close();
  }
});
