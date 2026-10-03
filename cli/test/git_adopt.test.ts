import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `git push` into a project that was started with `cbx submit`.
 *
 * The usual case: a working git repository whose CodeRook project was saved
 * with the CLI or the desktop app. The helper refused every push to it and
 * said to push to a new project — which is how one project became two. Now
 * the refusal says how to adopt, and `git push -o adopt` saves the commit on
 * top, after which pushes are ordinary fast-forwards.
 */

const home = mkdtempSync(path.join(tmpdir(), "coderook-adopt-"));
const PROJECT = "5d4c3b2a-0000-4000-8000-0000000ad097";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Version = { id: string; sequence: number; message: string; files: Map<string, string> };

function service() {
  const objects = new Map<string, string>(); /* objectId -> sha256 */
  const first: Version = {
    id: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    message: "Saved with cbx submit",
    files: new Map([
      ["a.txt", sha("alpha\n")],
      ["old.txt", sha("gone soon\n")],
    ]),
  };
  const versions: Version[] = [first];
  const posts: Array<{ baseVersionId?: string; message: string; files: string[] }> = [];
  const unknown: string[] = [];
  const head = () => versions[versions.length - 1]!;

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const body = () => JSON.parse(raw.toString("utf8") || "{}");
    const url = new URL(request.url ?? "/", "http://x");
    const method = request.method ?? "GET";
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const base = `/v1/repositories/${PROJECT}`;

    if (url.pathname === "/v1/auth/session") {
      return reply(200, { user: { email: "t@example.test", displayName: "Tester", username: "tester", plan: "pro" } });
    }
    if (url.pathname === "/health") return reply(200, { status: "ok", features: [], contentEncodings: ["identity"] });
    if (url.pathname === "/v1/repositories" && method === "GET") {
      return reply(200, {
        repositories: [{ id: PROJECT, slug: "app", displayName: "app", visibility: "private", versionCount: versions.length }],
      });
    }
    if (url.pathname === `${base}/tracks`) {
      return reply(200, { tracks: [{ name: "main", kind: "line", headVersionId: head().id }] });
    }
    if (url.pathname === `${base}/versions` && method === "GET") {
      return reply(200, {
        versions: [...versions].reverse().map((one) => ({
          id: one.id, sequence: one.sequence, message: one.message, state: "verified", createdAt: "2026-10-04T00:00:00Z",
        })),
      });
    }
    const filesMatch = url.pathname.match(/\/versions\/([^/]+)\/files$/);
    if (filesMatch && method === "GET") {
      const version = versions.find((one) => one.id === filesMatch[1]);
      if (!version) return reply(404, { error: { message: "no such version" } });
      return reply(200, {
        files: [...version.files].map(([file, digest]) => ({ path: file, sha256: digest, objectId: `obj-${digest}`, sourceSize: 1 })),
      });
    }
    if (url.pathname === `${base}/stored` && method === "POST") return reply(200, { stored: {} });
    if (url.pathname === `${base}/stored`) return reply(200, { stored: false });
    if (url.pathname === `${base}/uploads/preflight` && method === "POST") {
      const asked = body() as { sourceBytes: number; objects: Array<{ sha256: string; storedSize: number }> };
      return reply(201, {
        quoteId: "q-1", repositoryId: PROJECT, sourceBytes: asked.sourceBytes, excludedBytes: 0, compactedBytes: 0,
        reusableBytes: 0, chargeableBytes: 0,
        storage: { usedBytes: 0, quotaBytes: 1e12, remainingBytes: 1e12 },
        allowance: {
          exempt: true, stage: 1, unlockedPercent: 100, unlockedBytes: 1e12, chargedBytes: 0, reservedBytes: 0,
          remainingBytes: 1e12, periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", nextUnlockAt: null,
        },
        expiresAt: "2026-10-30T00:00:00.000Z",
        objects: Object.fromEntries(
          asked.objects.map((one) => [one.sha256, { objectId: `obj-${one.sha256}`, storedSize: one.storedSize, needsUpload: true }]),
        ),
      });
    }
    if (url.pathname.startsWith(`${base}/uploads/preflight/`) && method === "DELETE") return reply(200, {});
    const put = url.pathname.match(/\/objects\/([0-9a-f]{64})$/);
    if (put && method === "PUT") {
      objects.set(`obj-${put[1]}`, put[1]!);
      return reply(201, { objectId: `obj-${put[1]}`, size: raw.byteLength, storedSize: raw.byteLength });
    }
    if (url.pathname === `${base}/versions` && method === "POST") {
      const sent = body() as { baseVersionId?: string; message: string; files: Array<{ path: string; objectId?: string; sha256?: string }> };
      posts.push({ ...(sent.baseVersionId ? { baseVersionId: sent.baseVersionId } : {}), message: sent.message, files: sent.files.map((one) => one.path).sort() });
      const version: Version = {
        id: `00000000-0000-4000-8000-00000000000${versions.length + 1}`,
        sequence: versions.length + 1,
        message: sent.message,
        files: new Map(sent.files.map((one) => [one.path, one.sha256 ?? String(one.objectId).replace(/^obj-/, "")])),
      };
      versions.push(version);
      return reply(201, {
        version: { id: version.id, sequence: version.sequence },
        manifest: { files: [...version.files].map(([file, digest]) => ({ path: file, sha256: digest })) },
      });
    }
    unknown.push(`${method} ${url.pathname}`);
    return reply(404, { error: { message: `not faked: ${method} ${url.pathname}` } });
  });
  return { server, posts, unknown, versions };
}

/* Asynchronous on purpose: the fake service shares this process's event loop. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; out: string }>((done) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", () => done({ code: 1, out }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

test("a cbx-started project is adopted on request, then pushed to as usual", { timeout: 120_000 }, async (context) => {
  if ((await git(home, ["--version"])).code !== 0) return context.skip("git is not installed");
  const fake = service();
  await new Promise<void>((ready) => fake.server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${(fake.server.address() as { port: number }).port}`;
  try {
    /* The helper, found on PATH the way an npm install puts it there. */
    const bin = path.join(home, "bin");
    mkdirSync(bin);
    const helper = path.resolve("dist/cli/src/git_remote_bin.js").replace(/\\/g, "/");
    writeFileSync(path.join(bin, "git-remote-coderook"), `#!/bin/sh\nexec node "${helper}" "$@"\n`, { mode: 0o755 });
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CODEROOK_API_URL: origin,
      CODEROOK_TOKEN: "test-token",
      CODEROOK_CONFIG_DIR: home,
      GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.test",
    };

    const repo = path.join(home, "repo");
    mkdirSync(repo);
    assert.equal((await git(repo, ["init", "-q", "-b", "main"], env)).code, 0);
    writeFileSync(path.join(repo, "a.txt"), "alpha\n");
    writeFileSync(path.join(repo, "b.txt"), "beta\n");
    await git(repo, ["add", "."], env);
    await git(repo, ["commit", "-q", "-m", "Working tree as git knows it"], env);
    await git(repo, ["remote", "add", "coderook", "coderook://app"], env);

    /* Refused, and told how, with nothing sent. */
    const refused = await git(repo, ["push", "coderook", "main"], env);
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /git push -o adopt coderook main/);
    assert.match(refused.out, /git clone coderook:\/\/app/);
    assert.equal(fake.posts.length, 0);

    /* Adopted: one save on top of the cbx one, holding exactly the commit. */
    const tip = (await git(repo, ["rev-parse", "HEAD"], env)).out.trim();
    const adopted = await git(repo, ["push", "-o", "adopt", "coderook", "main"], env);
    assert.equal(adopted.code, 0, adopted.out + fake.unknown.join("\n"));
    assert.match(adopted.out, /adopting "app"/);
    assert.equal(fake.posts.length, 1);
    assert.equal(fake.posts[0]!.baseVersionId, fake.versions[0]!.id);
    assert.deepEqual(fake.posts[0]!.files, ["a.txt", "b.txt"], "old.txt, absent from the commit, is gone");
    assert.match(fake.posts[0]!.message, new RegExp(tip));

    /* From now on an ordinary push: one save per commit, on top of the adoption. */
    writeFileSync(path.join(repo, "c.txt"), "gamma\n");
    await git(repo, ["add", "."], env);
    await git(repo, ["commit", "-q", "-m", "Add c"], env);
    const next = await git(repo, ["push", "coderook", "main"], env);
    assert.equal(next.code, 0, next.out + fake.unknown.join("\n"));
    assert.equal(fake.posts.length, 2);
    assert.equal(fake.posts[1]!.baseVersionId, fake.versions[1]!.id);
    assert.deepEqual(fake.posts[1]!.files, ["a.txt", "b.txt", "c.txt"]);
  } finally {
    await new Promise<void>((done) => fake.server.close(() => done()));
  }
});
