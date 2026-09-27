import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `cbx pages`: a public project served as a website.
 *
 * Turning a site on puts the project's code in front of strangers, so most
 * of this is about what was sent: the question is asked when somebody can
 * answer, refused when nobody can, and the "find it for me" path changes the
 * project's .gitignore only when told to and never saves or publishes.
 */

const home = mkdtempSync(path.join(tmpdir(), "coderook-pages-"));
/* Set before the config module is loaded, so links are written here and not
   into the configuration of whoever runs the tests. */
process.env.CODEROOK_CONFIG_DIR = home;

const { splitPages, normaliseFolder, findWebBuilds, reinclusionFor } = await import(
  "../dist/cli/src/pages_command.js"
);
const { writeLink } = await import("../dist/cli/src/config.js");
const { collectLayers } = await import("../dist/cbx/src/core/worktree.js");
const { excludes } = await import("../dist/cbx/src/core/rules.js");

const PROJECT = "7d1c2a90-4b3e-4f6a-8c21-5e9f0a1b2c3d";
const ADDRESS = "https://harbor-game--studio.pages.example/";

type Sent = { method: string; url: string; body: unknown };
type Refusal = { status: number; code: string; message: string };

function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    folder: "",
    versionId: null,
    spa: false,
    isolation: false,
    address: null,
    domainReady: false,
    live: { id: "ver-12", sequence: 12, name: "Client build" },
    entry: { path: "index.html", found: true },
    blocked: null,
    ...overrides,
  };
}

const SUGGESTION = {
  version: { id: "ver-12", sequence: 12, name: "Client build" },
  suggestion: {
    folder: "Build/WebGL",
    kind: "unity",
    spa: false,
    isolation: false,
    why: "Build/WebGL/Build/game.loader.js is Unity's loader.",
  },
  candidates: [],
  problem: null,
};

const NOTHING = {
  version: { id: "ver-12", sequence: 12, name: null },
  suggestion: null,
  candidates: [],
  problem: "No index.html in the published files. If your build is in dist/ or build/, your ignore rules may have kept it out.",
};

async function service(options: {
  visibility?: string;
  pages?: Record<string, unknown>;
  detect?: unknown;
  refuse?: Refusal;
}) {
  const sent: Sent[] = [];
  let state = settings(options.pages);
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    sent.push({ method: request.method ?? "", url: request.url ?? "", body });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const refusal = () =>
      reply(options.refuse!.status, {
        error: { code: options.refuse!.code, message: options.refuse!.message },
      });
    const route = `/v1/repositories/${PROJECT}/pages`;
    if (request.url === "/v1/repositories" && request.method === "GET") {
      return reply(200, {
        repositories: [
          {
            id: PROJECT,
            slug: "harbor-game",
            displayName: "harbor-game",
            visibility: options.visibility ?? "public",
          },
        ],
      });
    }
    if (request.url === `/v1/repositories/${PROJECT}/versions`) {
      return reply(200, {
        versions: [
          { id: "ver-12", sequence: 12, name: "Client build", visibility: "public" },
          { id: "ver-11", sequence: 11, name: null, visibility: "public" },
        ],
      });
    }
    if (request.url === route && request.method === "GET") {
      if (options.refuse?.status === 503) return refusal();
      return reply(200, state);
    }
    if (request.url === route && request.method === "PUT") {
      if (options.refuse) return refusal();
      state = { ...state, ...(body as object) };
      return reply(200, state);
    }
    if (request.url === `${route}/detect` && request.method === "GET") {
      if (options.refuse?.status === 503) return refusal();
      return reply(200, options.detect ?? NOTHING);
    }
    if (request.url === `${route}/auto` && request.method === "POST") {
      if (options.refuse) return refusal();
      const found = (options.detect as typeof SUGGESTION).suggestion;
      state = { ...state, enabled: true, folder: found.folder };
      return reply(200, { ...state, applied: found });
    }
    return reply(404, { error: { code: "not_found", message: "Route not found" } });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as { port: number }).port;
  return {
    sent,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const atTerminal = path.join(home, "at-terminal.cjs");
writeFileSync(atTerminal, "process.stdin.isTTY = true;\n");
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function run(origin: string, args: string[], options: { answer?: string; cwd?: string } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    const child = execFile(
      process.execPath,
      [
        ...(options.answer === undefined ? [] : ["--require", atTerminal]),
        path.resolve("dist/cli/src/cli.js"),
        "pages",
        ...args,
      ],
      {
        cwd: options.cwd ?? home,
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
    child.stdin?.end(options.answer ?? "");
  });
}

const changes = (sent: Sent[]) =>
  sent.filter((one) => one.method === "PUT" || one.method === "POST");

/* ── pieces ─────────────────────────────────────────────────────────────── */

test("the action is recognised by being one; anything else is the project", () => {
  assert.deepEqual(splitPages([]), { action: "status", project: undefined });
  assert.deepEqual(splitPages(["blog"]), { action: "status", project: "blog" });
  assert.deepEqual(splitPages(["auto"]), { action: "auto", project: undefined });
  assert.deepEqual(splitPages(["ON", "blog"]), { action: "on", project: "blog" });
});

test("a typed folder is put the way the service wants it", () => {
  assert.equal(normaliseFolder("dist/"), "dist");
  assert.equal(normaliseFolder(".\\Build\\WebGL\\"), "Build/WebGL");
  assert.equal(normaliseFolder("."), "");
  assert.equal(normaliseFolder("/public"), "public");
});

test("builds on the disk are found, engines first", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "coderook-pages-builds-"));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "index.html"), "<p>hi</p>");
  mkdirSync(path.join(root, "Game", "Build"), { recursive: true });
  writeFileSync(path.join(root, "Game", "index.html"), "<p>game</p>");
  writeFileSync(path.join(root, "Game", "Build", "Game.loader.js"), "");
  mkdirSync(path.join(root, "templates"));
  writeFileSync(path.join(root, "templates", "index.html"), "<p>not a site</p>");
  mkdirSync(path.join(root, "export", "web"), { recursive: true });
  writeFileSync(path.join(root, "export", "web", "index.html"), "");
  writeFileSync(path.join(root, "export", "web", "game.pck"), "");
  const found = await findWebBuilds(root);
  assert.deepEqual(found, [
    { folder: "export/web", kind: "godot" },
    { folder: "Game", kind: "unity" },
    { folder: "dist", kind: "static" },
  ]);
});

test("a folder left out is brought back, checked by the same matcher a save uses", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "coderook-pages-rules-"));
  mkdirSync(path.join(root, "Build", "WebGL"), { recursive: true });
  writeFileSync(path.join(root, "Build", "WebGL", "index.html"), "");
  const rules = { shared: "[Bb]uild/\n", local: "" };
  const verdict = await reinclusionFor(root, "Build/WebGL", rules);
  assert.equal(verdict.excluded, true);
  assert.equal(verdict.rule, "[Bb]uild/");
  assert.deepEqual(verdict.lines, ["!/Build/"]);
  const after = await collectLayers(root, {
    shared: rules.shared + verdict.lines.join("\n") + "\n",
    local: "",
  });
  assert.equal(excludes("Build/WebGL/index.html", false, after), false);

  const clear = await reinclusionFor(root, "Build/WebGL", { shared: "*.log\n", local: "" });
  assert.equal(clear.excluded, false);
});

test("a rule in a deeper .gitignore is named rather than argued with", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "coderook-pages-nested-"));
  mkdirSync(path.join(root, "web", "dist"), { recursive: true });
  writeFileSync(path.join(root, "web", "dist", "index.html"), "");
  writeFileSync(path.join(root, "web", ".gitignore"), "dist/\n");
  const verdict = await reinclusionFor(root, "web/dist", { shared: "", local: "" });
  assert.equal(verdict.excluded, true);
  assert.equal(verdict.lines, null);
  assert.match(verdict.obstacle, /web\/\.gitignore has "dist\/"/);
});

/* ── through the real binary ────────────────────────────────────────────── */

test("status says on or off, where, what, and warns when the page is missing", async () => {
  const api = await service({
    pages: {
      enabled: true,
      folder: "dist",
      spa: true,
      entry: { path: "dist/index.html", found: false },
      blocked: "v12 has no dist/index.html.",
    },
  });
  try {
    const result = await run(api.origin, ["harbor-game"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /harbor-game — Pages is on/);
    assert.match(result.out, /Address\s+goes live when the Pages domain is set up/);
    assert.match(result.out, /Serving\s+v12 Client build\s+newest published/);
    assert.match(result.out, /Folder\s+dist\/\s+\(dist\/index\.html\)/);
    assert.match(result.out, /single-page app yes · cross-origin isolation no/);
    assert.match(result.out, /Warning: dist\/index\.html is not in v12/);
    assert.match(result.out, /Blocked\s+v12 has no dist\/index\.html\./);
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("status of a site that is off shows the address and how to turn it on", async () => {
  const api = await service({ pages: { address: ADDRESS, domainReady: true } });
  try {
    const result = await run(api.origin, ["status", "harbor-game"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Pages is off/);
    assert.match(result.out, new RegExp(`Address\\s+${ADDRESS.replace(/[./]/g, "\\$&")}`));
    assert.match(result.out, /cbx pages auto harbor-game/);
  } finally {
    await api.close();
  }
});

test("auto with a suggestion and --yes sends the auto request", async () => {
  const api = await service({ detect: SUGGESTION });
  try {
    const result = await run(api.origin, ["auto", "harbor-game", "--yes"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Found a Unity WebGL build in Build\/WebGL\/ of v12\./);
    assert.deepEqual(
      changes(api.sent).map((one) => [one.method, one.url]),
      [["POST", `/v1/repositories/${PROJECT}/pages/auto`]],
    );
    assert.match(result.out, /Pages is on for harbor-game\./);
  } finally {
    await api.close();
  }
});

test("auto with nobody to ask and no --yes is refused, and nothing is sent", async () => {
  const api = await service({ detect: SUGGESTION });
  try {
    const result = await run(api.origin, ["auto", "harbor-game"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /Found a Unity WebGL build/);
    assert.match(result.err, /needs a yes/);
    assert.match(result.err, /--yes/);
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("auto at a terminal says what goes public, and no sends nothing", async () => {
  const api = await service({ detect: SUGGESTION, pages: { address: ADDRESS } });
  try {
    const result = await run(api.origin, ["auto", "harbor-game"], { answer: "n\n" });
    assert.equal(result.code, 1);
    assert.match(result.out, /runs in their browser under the project's name/);
    assert.match(result.out, /Turn on Pages for harbor-game with this\? \[y\/N\]/);
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("auto with nothing published finds an ignored dist/ here and, with --yes, keeps it in", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "coderook-pages-folder-"));
  mkdirSync(path.join(folder, "dist", "assets"), { recursive: true });
  writeFileSync(path.join(folder, "dist", "index.html"), "<p>site</p>");
  writeFileSync(path.join(folder, "dist", "assets", "main.js"), "");
  writeFileSync(path.join(folder, ".gitignore"), "node_modules/\ndist/\n");
  await writeLink(folder, { repositoryId: PROJECT, slug: "harbor-game", sequence: 12, manifest: {} });

  const api = await service({ detect: NOTHING });
  try {
    /* Nobody to ask: explained, not changed. */
    const refused = await run(api.origin, ["auto"], { cwd: folder });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /a website is here in dist\//);
    assert.match(refused.out, /Your ignore rules leave dist\/ out of every save — "dist\/" in \.gitignore/);
    assert.match(refused.out, /!\/dist\//);
    assert.match(refused.err, /needs a yes/);
    assert.equal(readFileSync(path.join(folder, ".gitignore"), "utf8"), "node_modules/\ndist/\n");

    const result = await run(api.origin, ["auto", "--yes"], { cwd: folder });
    assert.equal(result.code, 0, result.err);
    const written = readFileSync(path.join(folder, ".gitignore"), "utf8");
    assert.match(written, /^node_modules\/\ndist\/\n\n# Kept for CodeRook Pages.*\n!\/dist\/\n$/);
    assert.match(result.out, /Added to \.gitignore/);
    assert.match(result.out, /cbx submit/);
    assert.match(result.out, /cbx promote/);
    assert.match(result.out, /cbx pages auto/);

    /* The same matcher a save uses now sends the build. */
    const layers = await collectLayers(folder, { shared: written, local: "" });
    assert.equal(excludes("dist/index.html", false, layers), false);
    assert.equal(excludes("dist/assets/main.js", false, layers), false);

    /* Never saved or published for them: only reads were sent. */
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("auto with nothing published and nothing here says the service's problem", async () => {
  const api = await service({ detect: NOTHING });
  try {
    const result = await run(api.origin, ["auto", "harbor-game"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /No index\.html in the published files/);
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("on sends what was asked for, after a yes", async () => {
  const api = await service({});
  try {
    const result = await run(api.origin, [
      "on", "harbor-game", "--folder", ".\\Build\\WebGL\\", "--isolate", "--no-spa",
      "--version", "12", "--yes",
    ]);
    assert.equal(result.code, 0, result.err);
    const puts = api.sent.filter((one) => one.method === "PUT");
    assert.deepEqual(puts.map((one) => one.body), [
      { enabled: true, folder: "Build/WebGL", spa: false, isolation: true, versionId: "ver-12" },
    ]);
    assert.match(result.out, /Pages is on for harbor-game\./);
  } finally {
    await api.close();
  }
});

test("on with nobody to ask is refused, and nothing is sent", async () => {
  const api = await service({});
  try {
    const result = await run(api.origin, ["on", "harbor-game", "--spa"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /needs a yes/);
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("on for a project that is not public is stopped before anything is sent", async () => {
  const api = await service({ visibility: "private" });
  try {
    const result = await run(api.origin, ["on", "harbor-game", "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /not public/);
    assert.match(result.err, /cbx visibility public harbor-game/);
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});

test("off asks nothing", async () => {
  const api = await service({ pages: { enabled: true } });
  try {
    const result = await run(api.origin, ["off", "harbor-game"]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(
      api.sent.filter((one) => one.method === "PUT").map((one) => one.body),
      [{ enabled: false }],
    );
    assert.match(result.out, /Pages is off for harbor-game\./);
  } finally {
    await api.close();
  }
});

test("only the owner: the service's refusal is said in its own words", async () => {
  const api = await service({
    refuse: {
      status: 403,
      code: "admin_required",
      message: "Access denied: only the project's owner or an admin can change its site",
    },
  });
  try {
    const result = await run(api.origin, ["off", "harbor-game"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /Access denied: only the project's owner or an admin/);
    assert.doesNotMatch(result.out, /Pages is off/);
  } finally {
    await api.close();
  }
});

test("a 409 is passed on as the service said it, with the next step", async () => {
  const api = await service({
    refuse: {
      status: 409,
      code: "pages_address_taken",
      message: "Another project already answers at that address.",
    },
  });
  try {
    const result = await run(api.origin, ["on", "harbor-game", "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /Another project already answers at that address\./);
  } finally {
    await api.close();
  }
  const needsPublic = await service({
    refuse: { status: 409, code: "pages_needs_public", message: "Make the project public first." },
  });
  try {
    const result = await run(needsPublic.origin, ["off", "harbor-game"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /Make the project public first\./);
    assert.match(result.err, /cbx visibility public harbor-game/);
  } finally {
    await needsPublic.close();
  }
});

test("a service without Pages says so plainly", async () => {
  const api = await service({
    refuse: { status: 503, code: "pages_not_ready", message: "pages_not_ready" },
  });
  try {
    const result = await run(api.origin, ["harbor-game"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /Pages is not available on this service yet\./);
    const auto = await run(api.origin, ["auto", "harbor-game", "--yes"]);
    assert.equal(auto.code, 1);
    assert.match(auto.err, /Pages is not available on this service yet\./);
    assert.equal(changes(api.sent).length, 0);
  } finally {
    await api.close();
  }
});
