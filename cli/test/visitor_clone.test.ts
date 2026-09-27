import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A folder cloned from somebody else's public project.
 *
 * The account's own project list holds only projects it is in, so every
 * command after `cbx clone owner/project` looked the project up there, did not
 * find it, and said it was "no longer on your account". It is reachable — the
 * service answers for an open project by id — and the folder can look and
 * fetch. What it cannot do is save into it, and it is told so plainly.
 */

const home = mkdtempSync(path.join(tmpdir(), "coderook-visitor-"));
process.env.CODEROOK_CONFIG_DIR = home;
const { writeLink } = await import("../dist/cli/src/config.js");

const PROJECT = "7c1f0a52-3e4b-4d6a-9f21-5b8e0c4d2a17";
const SAVE = "4f3e2d1c-0b9a-4876-9543-210fedcba987";
const folder = path.join(home, "their-project");
mkdirSync(folder);
writeFileSync(path.join(folder, "README.md"), "# Theirs\n");

await writeLink(folder, {
  repositoryId: PROJECT,
  slug: "their-project",
  sequence: 1,
  versionId: SAVE,
  baseVersionId: SAVE,
  manifest: { "README.md": "a".repeat(64) },
  local: { "README.md": "a".repeat(64) },
});

async function service() {
  const sent: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    sent.push(`${request.method} ${request.url}`);
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    /* Not one of this account's projects... */
    if (request.url === "/v1/repositories") return reply(200, { repositories: [] });
    /* ...but open, and the service says the caller is a visitor. */
    if (request.url === `/v1/repositories/${PROJECT}`) {
      return reply(200, {
        id: PROJECT,
        slug: "their-project",
        displayName: "their-project",
        visibility: "public",
        defaultBranch: "main",
        versionCount: 1,
        member: false,
      });
    }
    if (request.url === `/v1/repositories/${PROJECT}/versions`) {
      return reply(200, {
        versions: [{ id: SAVE, sequence: 1, state: "verified", createdAt: "2026-09-27T00:00:00Z" }],
      });
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

function run(origin: string, args: string[]) {
  return new Promise<{ code: number; out: string }>((done) => {
    const child = execFile(
      process.execPath,
      [path.resolve("dist/cli/src/cli.js"), ...args],
      {
        cwd: folder,
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
          out: String(stdout) + String(stderr),
        }),
    );
    child.stdin?.end("");
  });
}

test("saving into somebody else's project is refused plainly, and nothing is sent", async () => {
  const api = await service();
  try {
    const result = await run(api.origin, ["submit", "-m", "my change"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /Access denied: you are not a collaborator on their-project/);
    assert.doesNotMatch(result.out, /no longer on your account/);
    assert.equal(
      api.sent.filter((line) => line.startsWith("POST") || line.startsWith("PUT")).length,
      0,
    );
  } finally {
    await api.close();
  }
});

test("status finds the project rather than calling it gone", async () => {
  const api = await service();
  try {
    const result = await run(api.origin, ["status"]);
    assert.doesNotMatch(result.out, /no longer on your account/);
    assert.ok(api.sent.includes(`GET /v1/repositories/${PROJECT}`));
  } finally {
    await api.close();
  }
});
