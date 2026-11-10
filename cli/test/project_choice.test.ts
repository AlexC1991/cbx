import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A folder that is not linked is asked about, never matched by name.
 *
 * On a real account an inner folder called `voxai-coder` was joined to the
 * project of that name by `cbx status` — straight after `cbx unlink` — and its
 * saves laid a second copy of the app over the project's root for thirteen
 * versions. A Linux machine that did not know the folder started
 * `voxai-coder-linux` beside it. Both are the same missing question.
 */

const home = mkdtempSync(path.join(tmpdir(), "coderook-choice-"));
process.env.CODEROOK_CONFIG_DIR = home;
const { readLink } = await import("../dist/cli/src/config.js");
const { similarProjects, slugFor } = await import("../dist/cli/src/folder_match.js");

const PROJECT = "1b2c3d4e-0000-4000-8000-00000000c0de";
const SAVE = "9a8b7c6d-0000-4000-8000-00000000beef";
const SHA = "b".repeat(64);
const row = (slug: string, id = PROJECT) => ({
  id,
  slug,
  displayName: slug,
  visibility: "private",
  defaultBranch: "main",
  versionCount: 101,
  fileCount: 3,
  storedSize: 10,
});

async function service() {
  const sent: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    sent.push(`${request.method} ${request.url}`);
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/repositories") {
      return reply(200, { repositories: [row("voxai-coder"), row("unrelated", "2b2c3d4e-0000-4000-8000-00000000c0de")] });
    }
    if (request.url === `/v1/repositories/${PROJECT}/versions`) {
      return reply(200, {
        versions: [{ id: SAVE, sequence: 101, state: "verified", createdAt: "2026-10-03T00:00:00Z" }],
      });
    }
    if (request.url === `/v1/repositories/${PROJECT}/versions/${SAVE}/files`) {
      return reply(200, {
        files: ["package.json", "main.js", "README.md"].map((file) => ({ path: file, sha256: SHA, sourceSize: 1 })),
      });
    }
    return reply(404, { error: { message: "not here" } });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as { port: number }).port;
  return {
    sent,
    writes: () => sent.filter((line) => line.startsWith("POST") || line.startsWith("PUT")),
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function folderNamed(name: string) {
  const folder = path.join(mkdtempSync(path.join(home, "work-")), name);
  mkdirSync(folder);
  writeFileSync(path.join(folder, "package.json"), "{}\n");
  writeFileSync(path.join(folder, "main.js"), "// app\n");
  return folder;
}

function run(origin: string, folder: string, args: string[]) {
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

test("similar names are words added or taken away, not letters", () => {
  const all = ["voxai-coder", "voxai-coder-linux", "voxai-coderx", "coder", "apple"].map((slug) => ({
    id: slug, slug, name: slug, visibility: "private", defaultBranch: "main",
    versionCount: 1, fileCount: 1, storedBytes: 1, updatedAt: "",
  }));
  const found = similarProjects(all, "VoxAI Coder").map((like: { project: { slug: string }; sameName: boolean }) =>
    `${like.project.slug}${like.sameName ? "=" : ""}`);
  assert.deepEqual(found, ["voxai-coder=", "voxai-coder-linux"]);
  assert.deepEqual(similarProjects(all, "app"), []);
  assert.equal(slugFor("  Wallpaper Picker!! "), "wallpaper-picker");
});

test("status does not link a folder because its name matches a project", async () => {
  const api = await service();
  const folder = folderNamed("voxai-coder");
  try {
    const result = await run(api.origin, folder, ["status"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /This folder is not linked to a project/);
    assert.match(result.out, /voxai-coder\s+v101 · 2 of its 3 files are here at the same path · same name as this folder/);
    assert.match(result.out, /cbx link voxai-coder/);
    assert.equal(await readLink(folder), null);
    assert.equal(existsSync(path.join(folder, ".coderook", "link.json")), false);
  } finally {
    await api.close();
  }
});

test("a save from that folder is refused without --into or --new, and nothing is sent", async () => {
  const api = await service();
  const folder = folderNamed("voxai-coder");
  try {
    const result = await run(api.origin, folder, ["submit", "-m", "first"]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /cbx submit --into voxai-coder/);
    assert.match(result.out, /cbx submit --new --name <another-name>/);
    assert.deepEqual(api.writes(), []);
    assert.equal(await readLink(folder), null);
  } finally {
    await api.close();
  }
});

test("a similar name is asked about too: the Linux copy that became its own project", async () => {
  const api = await service();
  const folder = folderNamed("voxai-coder-linux");
  try {
    const result = await run(api.origin, folder, ["submit", "-m", "first"]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /voxai-coder\s+v101/);
    assert.match(result.out, /cbx submit --new\s/);
    assert.deepEqual(api.writes(), []);
  } finally {
    await api.close();
  }
});

test("--new cannot take a name that is already a project", async () => {
  const api = await service();
  const folder = folderNamed("voxai-coder");
  try {
    const result = await run(api.origin, folder, ["submit", "--new", "-m", "first"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /already has a project called voxai-coder/);
    assert.deepEqual(api.writes(), []);
  } finally {
    await api.close();
  }
});

test("--into and --new together are refused", async () => {
  const api = await service();
  const folder = folderNamed("voxai-coder");
  try {
    const result = await run(api.origin, folder, ["submit", "--into", "voxai-coder", "--new", "-m", "x"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /Pass --into or --new, not both/);
  } finally {
    await api.close();
  }
});

test("cbx link connects the folder on purpose, and a second link is refused", async () => {
  const api = await service();
  const folder = folderNamed("anything");
  try {
    const result = await run(api.origin, folder, ["link", "voxai-coder"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Linked anything to voxai-coder at v101/);
    const link = await readLink(folder);
    assert.equal(link?.slug, "voxai-coder");
    assert.equal(link?.baseVersionId, SAVE);
    assert.deepEqual(api.writes(), []);

    const again = await run(api.origin, folder, ["link", "unrelated"]);
    assert.equal(again.code, 1);
    assert.match(again.out, /already linked to voxai-coder/);

    const elsewhere = await run(api.origin, folder, ["submit", "--into", "unrelated", "-m", "x"]);
    assert.equal(elsewhere.code, 1);
    assert.match(elsewhere.out, /already linked to voxai-coder/);
  } finally {
    await api.close();
  }
});

test("cbx link stands on the head of the line after an undo, not the newest version", async () => {
  /* v42 was passed over by `cbx undo`: main is back on v41 and v42 is still in the history. */
  const V41 = "9a8b7c6d-0000-4000-8000-000000000041";
  const V42 = "9a8b7c6d-0000-4000-8000-000000000042";
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/repositories") return reply(200, { repositories: [row("night-shift")] });
    if (request.url === `/v1/repositories/${PROJECT}/versions`) {
      return reply(200, {
        versions: [
          { id: V42, sequence: 42, state: "verified", createdAt: "2026-10-10T02:00:00Z" },
          { id: V41, sequence: 41, state: "verified", createdAt: "2026-10-10T01:00:00Z" },
        ],
      });
    }
    if (request.url === `/v1/repositories/${PROJECT}/tracks`) {
      return reply(200, { tracks: [{ id: "t-main", name: "main", kind: "line", headVersionId: V41 }] });
    }
    if (request.url === `/v1/repositories/${PROJECT}/versions/${V41}/files`) {
      return reply(200, { files: [{ path: "main.js", sha256: SHA, sourceSize: 1 }] });
    }
    return reply(404, { error: { message: "not here" } });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const folder = folderNamed("night-shift");
    const result = await run(origin, folder, ["link", "night-shift"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /at v41/);
    const link = await readLink(folder);
    assert.equal(link?.baseVersionId, V41);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("cbx release names the head of the line after an undo, not the version it passed over", async () => {
  const V2 = "9a8b7c6d-0000-4000-8000-000000000002";
  const V3 = "9a8b7c6d-0000-4000-8000-000000000003";
  const released: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/repositories") return reply(200, { repositories: [row("lap-timer")] });
    if (request.url === `/v1/repositories/${PROJECT}/versions`) {
      return reply(200, {
        versions: [
          { id: V3, sequence: 3, state: "verified", message: "Speed up the timer", createdAt: "2026-10-11T02:00:00Z" },
          { id: V2, sequence: 2, state: "verified", message: "Add best lap", createdAt: "2026-10-11T01:00:00Z" },
        ],
      });
    }
    if (request.url === `/v1/repositories/${PROJECT}/tracks`) {
      return reply(200, { tracks: [{ id: "t-main", name: "main", kind: "line", headVersionId: V2 }] });
    }
    const release = request.url?.match(/\/versions\/([^/]+)\/release$/);
    if (request.method === "PUT" && release) {
      released.push(release[1]!);
      return reply(200, { release: { name: "v1.0", versionId: release[1] } });
    }
    return reply(404, { error: { message: "not here" } });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const folder = folderNamed("lap-timer");
    const result = await run(origin, folder, ["release", "v1.0", "lap-timer"]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(released, [V2]);
    assert.match(result.out.replace(/\x1b\[[0-9;]*m/g, ""), /at v2/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("an unlinked folder stays unlinked after status", async () => {
  const api = await service();
  const folder = folderNamed("voxai-coder");
  try {
    assert.equal((await run(api.origin, folder, ["link", "voxai-coder"])).code, 0);
    assert.equal((await run(api.origin, folder, ["unlink"])).code, 0);
    assert.equal(existsSync(path.join(folder, ".coderook")), false, "unlink leaves no empty .coderook behind");
    const result = await run(api.origin, folder, ["status"]);
    assert.doesNotMatch(result.out, /Linked this folder/);
    assert.equal(await readLink(folder), null);
  } finally {
    await api.close();
  }
});
