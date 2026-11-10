/**
 * Two copies of the same file are one upload.
 *
 * A folder often holds the same bytes under two names: a copied image, a
 * render kept beside its source. Both used to go up in full, in two lanes at
 * once. The second copy now waits for the first, finds the service holding
 * it, and costs a question rather than a transfer; the version still names
 * both paths.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Uploader } from "../dist/core/upload.js";

const repositoryId = "00000000-0000-4000-8000-0000000000d2";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A service that remembers what it holds and counts every object written. */
function service() {
  const held = new Map<string, string>();
  const puts = new Map<string, number>();
  let published: Array<{ path: string; objectId?: string }> = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.pathname === "/health") return json({ features: [], contentEncodings: ["identity"] });
    if (url.pathname.endsWith("/stored") && method === "POST") {
      const asked = (JSON.parse(String(init.body)) as { sha256: string[] }).sha256;
      return json({
        stored: Object.fromEntries(
          asked.filter((digest) => held.has(digest)).map((digest) => [digest, { objectId: held.get(digest), storedSize: 1 }]),
        ),
      });
    }
    if (url.pathname.endsWith("/stored")) {
      const digest = url.searchParams.get("sha256") ?? "";
      return json(held.has(digest) ? { stored: true, objectId: held.get(digest), storedSize: 1 } : { stored: false });
    }
    if (url.pathname.endsWith("/uploads/preflight")) {
      const request = JSON.parse(String(init.body)) as { sourceBytes: number; objects: Array<{ sha256: string; storedSize: number }> };
      return json(
        {
          quoteId: randomUUID(),
          repositoryId,
          sourceBytes: request.sourceBytes,
          excludedBytes: 0,
          compactedBytes: 0,
          reusableBytes: 0,
          chargeableBytes: 0,
          storage: { usedBytes: 0, quotaBytes: 1e12, remainingBytes: 1e12 },
          allowance: {
            exempt: true, stage: 1, unlockedPercent: 100, unlockedBytes: 1e12, chargedBytes: 0,
            reservedBytes: 0, remainingBytes: 1e12, periodStart: "2026-10-01T00:00:00.000Z",
            periodEnd: "2026-11-01T00:00:00.000Z", nextUnlockAt: null,
          },
          expiresAt: "2026-10-30T00:00:00.000Z",
          objects: Object.fromEntries(
            request.objects.map((one) => [
              one.sha256,
              { objectId: held.get(one.sha256) ?? `obj-${one.sha256.slice(0, 8)}`, storedSize: one.storedSize, needsUpload: !held.has(one.sha256) },
            ]),
          ),
        },
        201,
      );
    }
    if (method === "PUT" && url.pathname.includes("/objects/")) {
      const body = init.body as Uint8Array;
      const digest = url.pathname.split("/").pop()!;
      puts.set(digest, (puts.get(digest) ?? 0) + 1);
      /* Slow enough that two lanes sending the same file would overlap. */
      await new Promise((resolve) => setTimeout(resolve, 150));
      held.set(digest, `obj-${digest.slice(0, 8)}`);
      return json({ objectId: held.get(digest), size: body.byteLength, storedSize: body.byteLength }, 201);
    }
    if (url.pathname.endsWith("/versions") && method === "POST") {
      published = (JSON.parse(String(init.body)) as { files: typeof published }).files;
      return json(
        { version: { id: randomUUID(), sequence: 1 }, manifest: { files: published.map((one) => ({ path: one.path, sha256: "" })) } },
        201,
      );
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  return { fetcher, puts, published: () => published };
}

test("a file and its copy are sent once, and the version names both", { timeout: 60_000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cbx-dupes-"));
  /* Over a megabyte each, so each goes up as its own object through the lanes. */
  const same = randomBytes(1_200_000);
  const other = randomBytes(1_200_000);
  await writeFile(path.join(folder, "clip.bin"), same);
  await writeFile(path.join(folder, "clip-copy.bin"), same);
  await writeFile(path.join(folder, "other.bin"), other);
  const { fetcher, puts, published } = service();
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const result = await new Uploader({ origin: () => "https://api.example.test", token: async () => "t" }).run(
      {
        localPath: folder,
        excluded: [],
        include: [],
        message: "a copy",
        projectName: "dupes",
        repositoryId,
        baseVersionId: null,
      },
      () => undefined,
    );
    assert.equal(puts.get(sha(same)), 1, "the copy was sent again");
    assert.equal(puts.get(sha(other)), 1);
    assert.equal(Object.keys(result.manifest).length, 3);
    const named = published().map((one) => one.path).sort();
    assert.deepEqual(named, ["clip-copy.bin", "clip.bin", "other.bin"]);
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
