import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const { readLevel, splitVisibility, offeredPublicly } = await import(
  "../dist/cli/src/project_commands.js"
);
const { siteOrigin } = await import("../dist/cli/src/config.js");

/**
 * `cbx visibility`: who can reach a project.
 *
 * Opening a project up is the one change here that cannot be taken back, so
 * most of this is about that door — it asks when somebody can answer, it
 * refuses rather than hangs when nobody can, and going private never asks.
 */

const PROJECT = "0b0e2f64-5d1a-4c55-9b7e-3a3f1c2d4e5f";
const SAVES = [
  { sequence: 5, name: "v2.1", visibility: "public", state: "verified", removedAt: null },
  { sequence: 4, name: "v2.0", visibility: "private", state: "verified", removedAt: null },
  { sequence: 3, name: "v1.1", visibility: "public", state: "verified", removedAt: "2026-01-01" },
  { sequence: 2, name: "v1.0", visibility: "public", state: "held", removedAt: null },
  { sequence: 1, name: null, visibility: "public", state: "verified", removedAt: null },
];

test("the three levels, and the website's name for the middle one", () => {
  assert.equal(readLevel("public"), "public");
  assert.equal(readLevel("PRIVATE"), "private");
  assert.equal(readLevel("unlisted"), "unlisted");
  assert.equal(readLevel("link"), "unlisted");
  assert.equal(readLevel("link-only"), "unlisted");
  assert.equal(readLevel("pubic"), null);
  assert.equal(readLevel(undefined), null);
});

test("a level is recognised by being one; anything else is the project", () => {
  assert.deepEqual(splitVisibility([]), { project: undefined });
  assert.deepEqual(splitVisibility(["blog"]), { project: "blog" });
  assert.deepEqual(splitVisibility(["public"]), { level: "public", project: undefined });
  assert.deepEqual(splitVisibility(["private", "blog"]), { level: "private", project: "blog" });
});

test("two words where the first is not a level is a typo, not a project", () => {
  const read = splitVisibility(["pubic", "blog"]);
  assert.equal(read.level, undefined);
  assert.match(read.error ?? "", /not a visibility/);
});

test("the public page offers named, shown, finished versions still holding files", () => {
  const offered = offeredPublicly(SAVES);
  assert.deepEqual(
    offered.map((one: { sequence: number }) => one.sequence),
    [5],
  );
});

test("the site is the service without its api. prefix, or nothing", () => {
  assert.equal(siteOrigin("https://api.coderook.com"), "https://coderook.com");
  assert.equal(siteOrigin("http://127.0.0.1:8787"), null);
  assert.equal(siteOrigin("not a url"), null);
});

/*
  The rest runs the real binary against a stand-in service, so what is
  checked is what was actually sent — a confirmation that printed the right
  words and then changed the project anyway would pass a test of the words.
*/

type Sent = { method: string; url: string; body: unknown };

async function service(options: { visibility: string; refuse?: string }) {
  const sent: Sent[] = [];
  let visibility = options.visibility;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    sent.push({ method: request.method ?? "", url: request.url ?? "", body });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const row = () => ({
      id: PROJECT,
      slug: "harbor-game",
      displayName: "harbor-game",
      visibility,
    });
    if (request.url === "/v1/repositories" && request.method === "GET") {
      return reply(200, { repositories: [row()] });
    }
    if (request.url === `/v1/repositories/${PROJECT}/versions`) {
      return reply(200, {
        versions: SAVES.map((one) => ({ ...one, id: `v${one.sequence}` })),
      });
    }
    if (request.url === `/v1/repositories/${PROJECT}` && request.method === "PATCH") {
      if (options.refuse) {
        return reply(409, { error: { message: options.refuse } });
      }
      visibility = (body as { visibility: string }).visibility;
      return reply(200, row());
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

const home = mkdtempSync(path.join(tmpdir(), "coderook-visibility-"));
/*
  Somebody at a terminal, for the prompt. A pipe is what makes a test able to
  answer, and a pipe is exactly what the command refuses to ask — so the
  child is told its input is a terminal before the command looks.
*/
const atTerminal = path.join(home, "at-terminal.cjs");
writeFileSync(atTerminal, "process.stdin.isTTY = true;\n");
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/* Asynchronous, so the stand-in service can answer while it waits. */
function run(origin: string, args: string[], answer?: string) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    const child = execFile(
      process.execPath,
      [
        ...(answer === undefined ? [] : ["--require", atTerminal]),
        path.resolve("dist/cli/src/cli.js"),
        "visibility",
        ...args,
      ],
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
    child.stdin?.end(answer ?? "");
  });
}

const patches = (sent: Sent[]) => sent.filter((one) => one.method === "PATCH");

test("with no level it says what the project is and what each means", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["harbor-game"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /harbor-game is private\./);
    assert.match(result.out, /private\s+you and the people you invite/);
    assert.match(result.out, /unlisted\s+not listed anywhere/);
    assert.match(result.out, /public\s+listed on your profile/);
    assert.equal(patches(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("going public with nobody to ask is refused, and nothing is sent", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["public", "harbor-game"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /needs a yes/);
    assert.match(result.err, /--yes/);
    assert.equal(patches(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("--yes opens it up and says what the page offers", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["public", "harbor-game", "--yes"]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(patches(api.sent).map((one) => one.body), [{ visibility: "public" }]);
    assert.match(result.out, /harbor-game is now public/);
    assert.match(result.out, /offers 1 named version\./);
  } finally {
    await api.close();
  }
});

test("-y does the same for link only", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["link", "harbor-game", "-y"]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(patches(api.sent).map((one) => one.body), [{ visibility: "unlisted" }]);
    assert.match(result.out, /harbor-game is now link only\./);
  } finally {
    await api.close();
  }
});

test("going private asks nothing", async () => {
  const api = await service({ visibility: "public" });
  try {
    const result = await run(api.origin, ["private", "harbor-game"]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(patches(api.sent).map((one) => one.body), [{ visibility: "private" }]);
    assert.match(result.out, /harbor-game is now private\./);
  } finally {
    await api.close();
  }
});

test("asking for what it already is changes nothing", async () => {
  const api = await service({ visibility: "unlisted" });
  try {
    const result = await run(api.origin, ["unlisted", "harbor-game"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /already link only/);
    assert.equal(patches(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("the service's refusal is said in its own words", async () => {
  const api = await service({
    visibility: "private",
    refuse: "Choose an account username before publishing a repository",
  });
  try {
    const result = await run(api.origin, ["public", "harbor-game", "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /Choose an account username/);
    assert.doesNotMatch(result.out, /now public/);
  } finally {
    await api.close();
  }
});

test("a mistyped level is caught before anything is asked of the service", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["pubic", "harbor-game"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /"pubic" is not a visibility/);
    assert.equal(api.sent.length, 0);
  } finally {
    await api.close();
  }
});

test("at a terminal it says what becomes readable, and no means nothing is sent", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["public", "harbor-game"], "n\n");
    assert.equal(result.code, 1);
    assert.match(result.out, /lists it on your profile and in search/);
    assert.match(result.out, /offers 1 named version: v2\.1\./);
    assert.doesNotMatch(result.out, /every save/);
    assert.match(result.out, /Make harbor-game public\? \[y\/N\]/);
    assert.match(result.out, /Nothing changed\. harbor-game is still private\./);
    assert.equal(patches(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("at a terminal, yes goes ahead", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["unlisted", "harbor-game"], "y\n");
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /keeps it off your profile and out of search/);
    assert.deepEqual(patches(api.sent).map((one) => one.body), [{ visibility: "unlisted" }]);
    assert.match(result.out, /harbor-game is now link only\./);
  } finally {
    await api.close();
  }
});
