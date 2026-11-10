/**
 * A file written to between the plan and the send stops the save plainly.
 *
 * Found by saving a folder while a program appended to a text file in it.
 * The send read newer bytes than the plan had priced, the service refused
 * them as "a file that was not part of what it asked to send", and the advice
 * was to update the app. It now says which file changed, sends nothing, and
 * removes the project a first save's plan had created.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Uploader } from "../dist/core/upload.js";

const repositoryId = "00000000-0000-4000-8000-0000000000f4";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("a file that changed since the plan is named, and nothing is sent", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cbx-changed-"));
  await writeFile(path.join(folder, "steady.txt"), "does not change\n");
  await writeFile(path.join(folder, "live.txt"), "line 1\n");
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/health") return json({ features: [], contentEncodings: ["identity"] });
    if (url.pathname === "/v1/repositories" && method === "POST") return json({ id: repositoryId, slug: "changed" }, 201);
    if (url.pathname.endsWith("/stored")) return json({ stored: {} });
    if (url.pathname.endsWith("/uploads/preflight") && method === "POST") {
      const request = JSON.parse(String(init.body)) as { sourceBytes: number; objects: Array<{ sha256: string; storedSize: number }> };
      return json({
        quoteId: randomUUID(), repositoryId, sourceBytes: request.sourceBytes, excludedBytes: 0,
        compactedBytes: 0, reusableBytes: 0, chargeableBytes: 0,
        storage: { usedBytes: 0, quotaBytes: 1e12, remainingBytes: 1e12 },
        allowance: {
          exempt: true, stage: 1, unlockedPercent: 100, unlockedBytes: 1e12, chargedBytes: 0,
          reservedBytes: 0, remainingBytes: 1e12, periodStart: "2026-10-01T00:00:00.000Z",
          periodEnd: "2026-11-01T00:00:00.000Z", nextUnlockAt: null,
        },
        expiresAt: "2026-10-30T00:00:00.000Z",
        objects: Object.fromEntries(request.objects.map((one) => [one.sha256, { objectId: `obj-${one.sha256.slice(0, 8)}`, storedSize: one.storedSize, needsUpload: true }])),
      }, 201);
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  try {
    const uploader = new Uploader({ origin: () => "https://api.example.test", token: async () => "t" });
    const request = {
      localPath: folder, excluded: [], include: [], message: "first", projectName: "changed",
      repositoryId: null, baseVersionId: null,
    };
    const plan = await uploader.plan(request, () => undefined);
    /* The program writing to it carries on after the plan. */
    await new Promise((resolve) => setTimeout(resolve, 20));
    await appendFile(path.join(folder, "live.txt"), "line 2\n");
    await assert.rejects(
      uploader.execute(request, plan, () => undefined),
      /1 file changed while the save was running, so nothing was sent: live\.txt/,
    );
    assert.ok(
      !calls.some((call) => /objects/.test(call) && !call.startsWith("DELETE")),
      `objects were sent: ${calls.join(", ")}`,
    );
    assert.ok(
      calls.includes(`DELETE /v1/repositories/${repositoryId}`),
      "the project the plan created was left behind",
    );
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
