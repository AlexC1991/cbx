/**
 * A save cut off by a dropped connection, run again, sends only the rest.
 *
 * This is what makes resuming safe to do automatically: the second run asks
 * which pieces the service already holds and skips them, so nothing that
 * crossed the wire before the drop crosses it again, and the save it makes is
 * complete.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Uploader } from "../dist/core/upload.js";

const repositoryId = "00000000-0000-4000-8000-0000000000d1";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A service that remembers what it holds, and whose network can go down. */
function service() {
  const held = new Map<string, string>();
  const state = { down: false, puts: 0, putBytes: 0, published: 0 };
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
      /* Two pieces get through, then the connection is gone for good. */
      if (state.puts >= 2) state.down = true;
      if (state.down) throw new TypeError("fetch failed");
      const body = init.body as Uint8Array;
      const digest = url.pathname.split("/").pop()!;
      state.puts += 1;
      state.putBytes += body.byteLength;
      held.set(digest, `obj-${digest.slice(0, 8)}`);
      return json({ objectId: held.get(digest), size: body.byteLength, storedSize: body.byteLength }, 201);
    }
    if (url.pathname.endsWith("/versions") && method === "POST") {
      const sent = JSON.parse(String(init.body)) as { files: Array<{ path: string; objectId: string }> };
      state.published += 1;
      return json(
        { version: { id: randomUUID(), sequence: 1 }, manifest: { files: sent.files.map((one) => ({ path: one.path, sha256: "" })) } },
        201,
      );
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  return { fetcher, held, state };
}

test("a run after a dropped connection sends only what had not arrived", { timeout: 120_000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cbx-resume-"));
  const files = new Map<string, Buffer>();
  for (let at = 0; at < 5; at += 1) {
    /* Over a megabyte each, so each goes up as its own object. */
    const body = randomBytes(1_200_000);
    files.set(`asset-${at}.bin`, body);
    await writeFile(path.join(folder, `asset-${at}.bin`), body);
  }
  const { fetcher, held, state } = service();
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  const request = {
    localPath: folder,
    excluded: [],
    include: [],
    message: "five assets",
    projectName: "resume",
    repositoryId,
    baseVersionId: null,
  };
  try {
    const first = new Uploader({ origin: () => "https://api.example.test", token: async () => "t" });
    await assert.rejects(first.run(request, () => undefined));
    /* What a caller resuming does first: the failed attempt's other lanes stop. */
    first.cancel();
    /* The connection comes back while those lanes would still be retrying. */
    state.down = false;
    state.puts = -100;
    await new Promise((resolve) => setTimeout(resolve, 9_000));
    assert.equal(held.size, 2, "the cancelled attempt kept sending");
    assert.equal(state.published, 0);

    /* The same save is run again. */
    const before = state.putBytes;
    const result = await new Uploader({ origin: () => "https://api.example.test", token: async () => "t" }).run(request, () => undefined);
    const resent = state.putBytes - before;
    assert.equal(held.size, 5);
    assert.ok(resent <= 3 * 1_200_000 + 1_000, `sent ${resent} bytes again, more than the three missing files`);
    assert.equal(state.published, 1);
    assert.equal(Object.keys(result.manifest).length, 5);
    for (const [name, body] of files) assert.ok(held.has(sha(body)), `${name} is held`);
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
