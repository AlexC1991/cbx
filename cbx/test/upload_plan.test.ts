import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Uploader } from "../dist/core/upload.js";

const repositoryId = "00000000-0000-4000-8000-000000000111";
const quoteId = "00000000-0000-4000-8000-000000000222";
const objectId = "00000000-0000-4000-8000-000000000333";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("run obtains an exact compaction quote before sending any object body", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "coderook-plan-"));
  const originalFetch = globalThis.fetch;
  const events: Array<{ path: string; method: string; quote: string | null }> = [];
  let quotedStoredSize = 0;
  try {
    await writeFile(path.join(folder, "large.txt"), "repeatable text\n".repeat(2_000));
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      events.push({
        path: url.pathname,
        method,
        quote: headers.get("x-coderook-upload-quote"),
      });
      if (url.pathname === "/health") {
        return json({ features: [], contentEncodings: ["identity", "gzip"] });
      }
      if (url.pathname === "/v1/repositories" && method === "POST") {
        return json({ id: repositoryId }, 201);
      }
      if (url.pathname.endsWith("/stored") && method === "POST") {
        return json({ stored: {} });
      }
      if (url.pathname.endsWith("/stored") && method === "GET") {
        return json({ stored: false });
      }
      if (url.pathname.endsWith("/uploads/preflight")) {
        const request = JSON.parse(String(init.body)) as {
          sourceBytes: number;
          objects: Array<{
            sha256: string;
            size: number;
            storedSize: number;
            encoding: string;
            storedSha256: string;
          }>;
        };
        assert.equal(request.objects.length, 1);
        assert.equal(request.objects[0]!.size, request.sourceBytes);
        assert.equal(request.objects[0]!.encoding, "gzip");
        assert.ok(request.objects[0]!.storedSize < request.sourceBytes);
        quotedStoredSize = request.objects[0]!.storedSize;
        const sha256 = request.objects[0]!.sha256;
        return json({
          quoteId,
          repositoryId,
          sourceBytes: request.sourceBytes,
          excludedBytes: 0,
          compactedBytes: quotedStoredSize,
          reusableBytes: 0,
          chargeableBytes: quotedStoredSize,
          storage: {
            usedBytes: 0,
            quotaBytes: 1_000_000,
            remainingBytes: 1_000_000 - quotedStoredSize,
          },
          allowance: {
            exempt: false,
            stage: 1,
            unlockedPercent: 30,
            unlockedBytes: 300_000,
            chargedBytes: 0,
            reservedBytes: quotedStoredSize,
            remainingBytes: 300_000 - quotedStoredSize,
            periodStart: "2026-08-01T00:00:00.000Z",
            periodEnd: "2026-09-01T00:00:00.000Z",
            nextUnlockAt: "2026-08-08T00:00:00.000Z",
          },
          expiresAt: "2026-08-28T01:00:00.000Z",
          objects: {
            [sha256]: { objectId, storedSize: quotedStoredSize, needsUpload: true },
          },
        }, 201);
      }
      if (method === "PUT" && url.pathname.includes("/objects/")) {
        assert.equal(headers.get("x-coderook-upload-quote"), quoteId);
        assert.equal((init.body as Uint8Array).byteLength, quotedStoredSize);
        return json({ objectId, size: 32_000, storedSize: quotedStoredSize }, 201);
      }
      if (url.pathname.endsWith("/versions") && method === "POST") {
        return json({
          version: { id: crypto.randomUUID(), sequence: 1 },
          manifest: {
            files: [{ path: "large.txt", sha256: "a".repeat(64) }],
          },
        }, 201);
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    };

    const uploader = new Uploader({
      origin: () => "https://api.example.test",
      token: async () => "test-token",
    });
    await uploader.run(
      {
        localPath: folder,
        include: ["large.txt"],
        message: "planned",
        projectName: "planned",
        repositoryId: null,
        baseVersionId: null,
      },
      () => undefined,
    );

    const preflightAt = events.findIndex((event) =>
      event.path.endsWith("/uploads/preflight"),
    );
    const firstObjectAt = events.findIndex(
      (event) => event.method === "PUT" && event.path.includes("/objects/"),
    );
    assert.ok(preflightAt >= 0);
    assert.ok(firstObjectAt > preflightAt);
    assert.equal(
      events.slice(0, preflightAt).some((event) => event.method === "PUT"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, { recursive: true, force: true });
  }
});

test("cancelling a new-project plan releases the quote and only its new empty repository", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "coderook-cancel-plan-"));
  const originalFetch = globalThis.fetch;
  const deletes: string[] = [];
  try {
    await writeFile(path.join(folder, "one.txt"), "planned cancellation\n".repeat(500));
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      if (url.pathname === "/health") {
        return json({ features: [], contentEncodings: ["identity", "gzip"] });
      }
      if (url.pathname === "/v1/repositories" && method === "POST") {
        return json({ id: repositoryId }, 201);
      }
      if (url.pathname.endsWith("/stored")) return json({ stored: {} });
      if (url.pathname.endsWith("/uploads/preflight") && method === "POST") {
        const request = JSON.parse(String(init.body)) as {
          sourceBytes: number;
          objects: Array<{ sha256: string; storedSize: number }>;
        };
        const definition = request.objects[0]!;
        return json({
          quoteId,
          repositoryId,
          sourceBytes: request.sourceBytes,
          excludedBytes: 0,
          compactedBytes: definition.storedSize,
          reusableBytes: 0,
          chargeableBytes: definition.storedSize,
          storage: { usedBytes: 0, quotaBytes: 1_000_000, remainingBytes: 900_000 },
          allowance: {
            exempt: false,
            stage: 1,
            unlockedPercent: 30,
            unlockedBytes: 300_000,
            chargedBytes: 0,
            reservedBytes: definition.storedSize,
            remainingBytes: 300_000 - definition.storedSize,
            periodStart: "2026-08-01T00:00:00.000Z",
            periodEnd: "2026-09-01T00:00:00.000Z",
            nextUnlockAt: "2026-08-08T00:00:00.000Z",
          },
          expiresAt: "2026-08-28T01:00:00.000Z",
          objects: {
            [definition.sha256]: {
              objectId,
              storedSize: definition.storedSize,
              needsUpload: true,
            },
          },
        }, 201);
      }
      if (method === "DELETE") {
        deletes.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") throw new Error("cancellation sent an object body");
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    };

    const uploader = new Uploader({
      origin: () => "https://api.example.test",
      token: async () => "test-token",
    });
    const plan = await uploader.plan(
      {
        localPath: folder,
        include: ["one.txt"],
        message: "cancelled",
        projectName: "cancelled",
        repositoryId: null,
        baseVersionId: null,
      },
      () => undefined,
    );
    assert.equal(plan.repositoryCreated, true);
    await uploader.cancelPlan(plan, true);
    assert.deepEqual(deletes, [
      `/v1/repositories/${repositoryId}/uploads/preflight/${quoteId}`,
      `/v1/repositories/${repositoryId}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, { recursive: true, force: true });
  }
});
