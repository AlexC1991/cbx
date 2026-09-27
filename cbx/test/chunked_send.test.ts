/**
 * A large file, planned and then sent, against a service that keeps count.
 *
 * Three things went wrong here together, and none of them showed in a test
 * that did not touch the network:
 *
 * - The file was walked twice, once to plan and once to send, and each walk
 *   asked the service about every four chunks and waited for the answer
 *   before reading on. A 10.6 GB project is 8,395 chunks: 2,099 lookups per
 *   pass at about a third of a second each — twelve minutes of waiting, twice.
 * - Each pass decided afresh whether to compress each chunk, and one of those
 *   decisions depends on which of four lanes finishes first. The service holds
 *   every piece to exactly the encoding it quoted, so a pass that disagreed
 *   with the plan about one chunk would have the whole save refused.
 * - A piece read by position has to be the piece that was planned.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { Uploader } from "../dist/core/upload.js";

const repositoryId = "00000000-0000-4000-8000-000000000111";
const quoteId = "00000000-0000-4000-8000-000000000222";
const MIB = 1024 * 1024;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Mostly incompressible, with one megabyte in eight of plain text: enough for
 * some chunks to keep their compression and for the file as a whole to give it
 * up part of the way through — which is exactly where two passes could differ.
 */
function mixedFile(megabytes: number): Buffer {
  const out = Buffer.alloc(megabytes * MIB);
  let state = 0x1234567;
  for (let at = 0; at < out.length; at += 1) {
    if (Math.floor(at / MIB) % 8 === 0) {
      out[at] = "the quick brown fox. ".charCodeAt(at % 21);
      continue;
    }
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[at] = state & 0xff;
  }
  return out;
}

type Service = {
  storedLookups: number;
  quoted: Map<string, { encoding: string; storedSize: number }>;
  put: Map<string, { encoding: string; body: Uint8Array }>;
  held: Set<string>;
};

/** Just enough of the service for a single large file to go up. */
function fakeService(held = new Set<string>()): Service & { fetch: typeof fetch } {
  const service: Service = {
    storedLookups: 0,
    quoted: new Map(),
    put: new Map(),
    held,
  };
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.pathname === "/health") {
      return json({
        features: ["chunked-files", "microchunk-map-v1"],
        contentEncodings: ["identity", "gzip"],
      });
    }
    if (url.pathname === "/v1/repositories" && method === "POST") {
      return json({ id: repositoryId }, 201);
    }
    if (url.pathname.endsWith("/stored") && method === "POST") {
      service.storedLookups += 1;
      const asked = (JSON.parse(String(init.body)) as { sha256: string[] }).sha256;
      const stored: Record<string, { objectId: string; storedSize: number }> = {};
      for (const digest of asked) {
        if (service.held.has(digest)) {
          stored[digest] = { objectId: `held-${digest.slice(0, 8)}`, storedSize: 1 };
        }
      }
      return json({ stored });
    }
    if (url.pathname.endsWith("/stored") && method === "GET") {
      return json({ stored: false });
    }
    if (url.pathname.endsWith("/uploads/preflight")) {
      const request = JSON.parse(String(init.body)) as {
        sourceBytes: number;
        objects: Array<{ sha256: string; storedSize: number; encoding: string }>;
      };
      const objects: Record<string, unknown> = {};
      for (const one of request.objects) {
        service.quoted.set(one.sha256, { encoding: one.encoding, storedSize: one.storedSize });
        objects[one.sha256] = {
          objectId: `obj-${one.sha256.slice(0, 8)}`,
          storedSize: one.storedSize,
          needsUpload: true,
        };
      }
      return json(
        {
          quoteId,
          repositoryId,
          sourceBytes: request.sourceBytes,
          excludedBytes: 0,
          compactedBytes: 0,
          reusableBytes: 0,
          chargeableBytes: 0,
          storage: { usedBytes: 0, quotaBytes: 1e12, remainingBytes: 1e12 },
          allowance: {
            exempt: true,
            stage: 1,
            unlockedPercent: 100,
            unlockedBytes: 1e12,
            chargedBytes: 0,
            reservedBytes: 0,
            remainingBytes: 1e12,
            periodStart: "2026-09-01T00:00:00.000Z",
            periodEnd: "2026-10-01T00:00:00.000Z",
            nextUnlockAt: null,
          },
          expiresAt: "2026-09-30T00:00:00.000Z",
          objects,
        },
        201,
      );
    }
    if (method === "PUT" && url.pathname.includes("/objects/")) {
      const digest = url.pathname.split("/").pop()!;
      const encoding = url.searchParams.get("encoding") ?? "identity";
      const body = init.body as Uint8Array;
      /* As the real service does: a piece must be the one that was quoted. */
      const quoted = service.quoted.get(digest);
      if (!quoted || quoted.encoding !== encoding || quoted.storedSize !== body.byteLength) {
        return json({ error: { code: "upload_quote_invalid" } }, 409);
      }
      service.put.set(digest, { encoding, body });
      return json({ objectId: `obj-${digest.slice(0, 8)}`, size: body.byteLength, storedSize: body.byteLength }, 201);
    }
    if (url.pathname.endsWith("/versions") && method === "POST") {
      return json(
        {
          version: { id: crypto.randomUUID(), sequence: 1 },
          manifest: { files: [] },
        },
        201,
      );
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  return Object.assign(service, { fetch: fetchImpl });
}

async function project(bytes: Buffer, name = "weights.unheardof") {
  const folder = await mkdtemp(path.join(os.tmpdir(), "coderook-chunked-"));
  await writeFile(path.join(folder, name), bytes);
  return { folder, name };
}

const uploader = () =>
  new Uploader({
    origin: () => "https://api.example.test",
    token: async () => "test-token",
  });

const request = (folder: string, name: string) => ({
  localPath: folder,
  include: [name],
  message: "chunked",
  projectName: "chunked",
  repositoryId: null,
  baseVersionId: null,
});

test("a large file is looked up in one request per pass, not one per four chunks", async () => {
  const bytes = mixedFile(48);
  const { folder, name } = await project(bytes);
  const service = fakeService();
  const original = globalThis.fetch;
  globalThis.fetch = service.fetch;
  try {
    await uploader().run(request(folder, name), () => undefined);
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
  const chunks = service.put.size;
  assert.ok(chunks >= 20, `expected dozens of chunks, got ${chunks}`);
  assert.ok(
    service.storedLookups <= 4,
    `${service.storedLookups} lookups for ${chunks} chunks — it was one per four, twice`,
  );
});

test("every chunk goes up exactly as the quote said it would", async () => {
  /*
    The service rejects any piece whose encoding differs from its quote. The
    give-up rule flips partway through this file, and it depends on which lane
    finishes compressing first — so the send must repeat the plan's answers.
  */
  const bytes = mixedFile(48);
  const { folder, name } = await project(bytes);
  const service = fakeService();
  const original = globalThis.fetch;
  globalThis.fetch = service.fetch;
  try {
    await uploader().run(request(folder, name), () => undefined);
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
  const encodings = new Set([...service.put.values()].map((one) => one.encoding));
  assert.ok(encodings.has("gzip") && encodings.has("identity"), "both kinds, so the rule was exercised");
  for (const [digest, sent] of service.put) {
    const quoted = service.quoted.get(digest);
    assert.ok(quoted, `sent a piece that was never quoted: ${digest}`);
    assert.equal(sent.encoding, quoted.encoding, `encoding of ${digest.slice(0, 12)}`);
    assert.equal(sent.body.byteLength, quoted.storedSize, `size of ${digest.slice(0, 12)}`);
    const plain = sent.encoding === "gzip" ? gunzipSync(sent.body) : sent.body;
    assert.equal(sha(plain), digest, "the bytes are the piece they claim to be");
  }
});

test("pieces already held are neither sent nor read", async () => {
  const bytes = mixedFile(24);
  const first = await project(bytes);
  const learn = fakeService();
  const original = globalThis.fetch;
  globalThis.fetch = learn.fetch;
  try {
    await uploader().run(request(first.folder, first.name), () => undefined);
  } finally {
    globalThis.fetch = original;
    await rm(first.folder, { recursive: true, force: true });
  }
  const all = [...learn.put.keys()];
  const held = new Set(all.filter((_digest, at) => at % 2 === 0));

  const second = await project(bytes);
  const service = fakeService(held);
  globalThis.fetch = service.fetch;
  try {
    await uploader().run(request(second.folder, second.name), () => undefined);
  } finally {
    globalThis.fetch = original;
    await rm(second.folder, { recursive: true, force: true });
  }
  for (const digest of held) assert.ok(!service.put.has(digest), "a held piece was sent");
  assert.equal(service.put.size, all.length - held.size);
});

test("a file edited between the plan and the send is refused in words", async () => {
  /*
    The send reads pieces by position using the plan's cut. Written to in
    place with its size and time put back, the file would otherwise send
    whatever now sits at those offsets under the old digests.
  */
  const bytes = mixedFile(24);
  const { folder, name } = await project(bytes);
  const full = path.join(folder, name);
  const service = fakeService();
  const original = globalThis.fetch;
  globalThis.fetch = service.fetch;
  const sender = uploader();
  /*
    A whole second, because NTFS keeps a hundred nanoseconds and utimes cannot
    put an arbitrary time back exactly. Restored imprecisely, the time moves,
    the send rightly re-reads the whole file, and this never reaches the check.
  */
  const moment = new Date(1_750_000_000_000);
  await utimes(full, moment, moment);
  try {
    const plan = await sender.plan(request(folder, name), () => undefined);
    const handle = await open(full, "r+");
    await handle.write(Buffer.from("edited in place"), 0, 15, 20 * MIB);
    await handle.close();
    await utimes(full, moment, moment);
    assert.equal((await stat(full)).mtimeMs, moment.getTime(), "time restored exactly");
    await assert.rejects(
      sender.execute(request(folder, name), plan, () => undefined),
      /changed while it was being saved/,
    );
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
