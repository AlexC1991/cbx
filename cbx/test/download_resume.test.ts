/**
 * A download whose connection is cut partway through a body carries on.
 *
 * Observed 2026-10-18: eight clones of a 14,108-file project started seconds
 * after the API was redeployed; four ended with the single word `terminated`
 * and left `<dir>.incoming` behind. The retry covered only the wait for
 * headers, so a body cut mid-stream escaped it, and the lanes still running
 * rebuilt the staging folder after the failure had removed it.
 *
 * These use a real server that really hangs up, so what the client sees is
 * undici's own error rather than one a test made up.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DownloadFailed, Downloader } from "../dist/core/download.js";

const digest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");

type Handler = (request: IncomingMessage, response: ServerResponse, count: number) => void;

/** A server on a free port, with a count of requests per path. */
async function serving(
  routes: Record<string, Handler>,
  run: (origin: string, folder: string, seen: Map<string, IncomingMessage[]>) => Promise<void>,
) {
  const seen = new Map<string, IncomingMessage[]>();
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? "/", "http://x").pathname;
    const list = seen.get(route) ?? [];
    list.push(request);
    seen.set(route, list);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (route.includes(suffix)) return handler(request, response, list.length);
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const folder = await mkdtemp(path.join(tmpdir(), "cbx-resume-"));
  try {
    await run(`http://127.0.0.1:${port}`, folder, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
}

const credentials = (origin: string) => ({ origin: () => origin, token: async () => "t" });

/** Send `body` whole, or from a `range` header when `ranges` is on. */
function send(body: Buffer, ranges: boolean): Handler {
  return (request, response) => {
    const asked = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    if (ranges && asked) {
      const from = Number(asked[1]);
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "content-length": body.length - from,
        "content-range": `bytes ${from}-${body.length - 1}/${body.length}`,
      });
      response.end(body.subarray(from));
      return;
    }
    response.writeHead(200, {
      "content-length": body.length,
      ...(ranges ? { "accept-ranges": "bytes" } : {}),
    });
    response.end(body);
  };
}

/** Promise the whole body, send `keep` bytes of it, then hang up. */
function cutAfter(body: Buffer, keep: number, ranges = true): Handler {
  return (_request, response) => {
    response.writeHead(200, {
      "content-length": body.length,
      ...(ranges ? { "accept-ranges": "bytes" } : {}),
    });
    response.write(body.subarray(0, keep), () => {
      setTimeout(() => response.socket?.destroy(), 20);
    });
  };
}

/** The first `times` requests are cut; the rest are answered properly. */
function cutFirst(times: number, body: Buffer, keep: number, ranges = true): Handler {
  return (request, response, count) =>
    count <= times
      ? cutAfter(body, keep, ranges)(request, response, count)
      : send(body, ranges)(request, response, count);
}

const listing = (files: unknown[]): Handler => (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ files }));
};

async function absent(target: string): Promise<boolean> {
  try {
    await stat(target);
    return false;
  } catch {
    return true;
  }
}

test("a file cut mid-stream resumes from the byte it reached", async () => {
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let at = 0; at < big.length; at += 1) big[at] = (at * 31) % 251;
  await serving(
    {
      "/versions/v1/files": listing([
        { path: "assets/big.bin", objectId: "big", sha256: digest(big), sourceSize: big.length },
      ]),
      "/objects/big": cutFirst(1, big, 1024 * 1024),
    },
    async (origin, folder, seen) => {
      const destination = path.join(folder, "clone");
      const result = await new Downloader(credentials(origin)).run("r1", "v1", destination, () => {});
      assert.equal(result.files, 1);
      assert.equal(digest(await readFile(path.join(destination, "assets", "big.bin"))), digest(big));
      const asked = seen.get("/v1/repositories/r1/objects/big") ?? [];
      assert.equal(asked.length, 2, "one cut, one resume");
      assert.equal(asked[0]!.headers.range, undefined);
      /* Asked only for what was missing, from wherever the disk had reached. */
      const from = Number(/^bytes=(\d+)-$/.exec(asked[1]!.headers.range ?? "")?.[1]);
      assert.ok(from > 0 && from <= 1024 * 1024, `resumed from ${from}`);
      assert.ok(await absent(`${destination}.incoming`));
    },
  );
});

test("without byte ranges a cut file is fetched again from the start", async () => {
  const body = Buffer.from("x".repeat(200_000));
  await serving(
    {
      "/versions/v1/files": listing([
        { path: "a.txt", objectId: "a", sha256: digest(body), sourceSize: body.length },
      ]),
      "/objects/a": cutFirst(2, body, 50_000, false),
    },
    async (origin, folder, seen) => {
      const destination = path.join(folder, "clone");
      await new Downloader(credentials(origin)).run("r1", "v1", destination, () => {});
      assert.equal(await readFile(path.join(destination, "a.txt"), "utf8"), body.toString());
      const asked = seen.get("/v1/repositories/r1/objects/a") ?? [];
      assert.equal(asked.length, 3);
      assert.ok(asked.every((one) => one.headers.range === undefined));
    },
  );
});

test("a pack and a piece cut mid-body are fetched again, and nothing else is", async () => {
  const first = Buffer.from("first packed file\n".repeat(4000));
  const second = Buffer.from("second packed file\n".repeat(4000));
  const pack = Buffer.concat([first, second]);
  const pieceOne = Buffer.alloc(300_000, 1);
  const pieceTwo = Buffer.alloc(300_000, 2);
  const whole = Buffer.concat([pieceOne, pieceTwo]);
  await serving(
    {
      "/versions/v1/files": listing([
        {
          path: "small/first.txt",
          sha256: digest(first),
          sourceSize: first.length,
          pack: { objectId: "pack", offset: 0, length: first.length },
        },
        {
          path: "small/second.txt",
          sha256: digest(second),
          sourceSize: second.length,
          pack: { objectId: "pack", offset: first.length, length: second.length },
        },
        {
          path: "large.bin",
          sha256: digest(whole),
          sourceSize: whole.length,
          chunks: [
            { objectId: "p1", sha256: digest(pieceOne), sourceSize: pieceOne.length },
            { objectId: "p2", sha256: digest(pieceTwo), sourceSize: pieceTwo.length },
          ],
        },
      ]),
      "/objects/pack": cutFirst(1, pack, 10_000, false),
      "/objects/p1": send(pieceOne, false),
      "/objects/p2": cutFirst(1, pieceTwo, 100_000, false),
    },
    async (origin, folder, seen) => {
      const destination = path.join(folder, "clone");
      const result = await new Downloader(credentials(origin)).run("r1", "v1", destination, () => {});
      assert.equal(result.files, 3);
      assert.equal(await readFile(path.join(destination, "small", "second.txt"), "utf8"), second.toString());
      assert.equal(digest(await readFile(path.join(destination, "large.bin"))), digest(whole));
      assert.equal(seen.get("/v1/repositories/r1/objects/pack")?.length, 2);
      assert.equal(seen.get("/v1/repositories/r1/objects/p1")?.length, 1, "the finished piece stays");
      assert.equal(seen.get("/v1/repositories/r1/objects/p2")?.length, 2);
    },
  );
});

test("a file that never arrives is named, and the staging folder is gone", async () => {
  const broken = Buffer.from("never whole ".repeat(20_000));
  const slow = Buffer.alloc(40 * 1024, 7);
  await serving(
    {
      "/versions/v1/files": listing([
        { path: "src/broken.dat", objectId: "broken", sha256: digest(broken), sourceSize: broken.length },
        ...Array.from({ length: 60 }, (_, at) => ({
          path: `src/slow-${at}.dat`,
          objectId: `slow-${at}`,
          sha256: digest(slow),
          sourceSize: slow.length,
        })),
      ]),
      "/objects/broken": cutAfter(broken, 1000, false),
      /*
        Sixty siblings of about two seconds each, so when the broken file
        gives up the other lanes are mid-write and still taking new work.
        Those are the lanes that used to rebuild the staging folder after the
        failure had removed it.
      */
      "/objects/slow-": (_request, response) => {
        response.writeHead(200, { "content-length": slow.length });
        let at = 0;
        const step = () => {
          if (response.destroyed) return;
          if (at >= slow.length) return void response.end();
          response.write(slow.subarray(at, at + 4096));
          at += 4096;
          setTimeout(step, 200);
        };
        step();
      },
    },
    async (origin, folder) => {
      const destination = path.join(folder, "clone");
      const failure = await new Downloader(credentials(origin))
        .run("r1", "v1", destination, () => {})
        .then(() => null, (error: unknown) => error);
      assert.ok(failure instanceof DownloadFailed, `got ${String(failure)}`);
      assert.match(failure.message, /^Could not download src\/broken\.dat: /);
      assert.match(failure.message, /the connection closed before it finished arriving/);
      assert.match(failure.message, /\(tried 5 times\)\.$/);
      assert.doesNotMatch(failure.message, /^terminated$/);
      assert.ok(await absent(`${destination}.incoming`));
      /* Still gone once anything that might have been running has had time. */
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.ok(await absent(`${destination}.incoming`), "no lane rebuilt the staging folder");
      assert.ok(await absent(destination), "the destination was never made");
    },
  );
});

test("a refusal is not retried and keeps its own words", async () => {
  const body = Buffer.from("gone");
  await serving(
    {
      "/versions/v1/files": listing([
        { path: "gone.txt", objectId: "gone", sha256: digest(body), sourceSize: body.length },
      ]),
      "/objects/gone": (_request, response) => {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "not_found", message: "Object not found" } }));
      },
    },
    async (origin, folder, seen) => {
      const destination = path.join(folder, "clone");
      const failure = await new Downloader(credentials(origin))
        .run("r1", "v1", destination, () => {})
        .then(() => null, (error: unknown) => error);
      assert.ok(failure instanceof DownloadFailed);
      assert.equal(failure.status, 404);
      assert.equal(failure.message, "Could not download gone.txt: CodeRook answered 404: Object not found.");
      assert.equal(seen.get("/v1/repositories/r1/objects/gone")?.length, 1);
    },
  );
});
