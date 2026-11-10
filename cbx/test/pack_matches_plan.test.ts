/**
 * The packs a save sends are the packs its plan priced.
 *
 * Found by saving a copy of Blender 4.5, which failed partway through every
 * time with "This save is sending a file that was not part of what it asked
 * to send". The plan asks the service what it already holds and stores
 * nothing, so every section of the plan heard the same answer. The send asked
 * again at the start of each section — by which time earlier sections had
 * stored their files — so a later section holding a copy of an earlier file
 * left the copy out of its pack. Different members, different digest, and the
 * service refused a pack it had never priced. Blender holds 326 contents more
 * than once; one is enough.
 *
 * Sections carry at most 4,000 files, so 4,001 small files and one copy make
 * two of them, with the copy in the second.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Uploader } from "../dist/core/upload.js";

const repositoryId = "00000000-0000-4000-8000-0000000000e3";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function bodyOf(init: RequestInit): Promise<Buffer> {
  return Buffer.from(await new Response(init.body as BodyInit).arrayBuffer());
}

/** A service that holds what it is sent and refuses anything its quote did not name. */
function service() {
  const held = new Set<string>();
  const priced = new Set<string>();
  const refused: string[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.pathname === "/health") {
      return json({ features: ["solid-packs"], contentEncodings: ["identity"] });
    }
    if (url.pathname.endsWith("/stored") && method === "POST") {
      const asked = (JSON.parse(String(init.body)) as { sha256: string[] }).sha256;
      return json({
        stored: Object.fromEntries(
          asked.filter((digest) => held.has(digest)).map((digest) => [digest, { objectId: `obj-${digest.slice(0, 8)}`, storedSize: 1 }]),
        ),
      });
    }
    if (url.pathname.endsWith("/uploads/preflight") && method === "POST") {
      const request = JSON.parse(String(init.body)) as {
        sourceBytes: number;
        objects: Array<{ sha256: string; storedSize: number }>;
      };
      for (const one of request.objects) priced.add(one.sha256);
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
              { objectId: `obj-${one.sha256.slice(0, 8)}`, storedSize: one.storedSize, needsUpload: !held.has(one.sha256) },
            ]),
          ),
        },
        201,
      );
    }
    if (url.pathname.endsWith("/objects/pack") && method === "POST") {
      const body = await bodyOf(init);
      const length = body.readUInt32BE(0);
      const manifest = JSON.parse(body.subarray(4, 4 + length).toString("utf8")) as {
        sha256: string;
        members: Array<{ sha256: string }>;
      };
      if (!priced.has(manifest.sha256)) {
        refused.push(manifest.sha256);
        return json({ error: { code: "upload_quote_invalid", message: "not part of what it asked to send" } }, 409);
      }
      for (const member of manifest.members) held.add(member.sha256);
      return json({ packObjectId: `pack-${manifest.sha256.slice(0, 8)}`, storedSize: body.byteLength - 4 - length }, 201);
    }
    if (url.pathname.endsWith("/objects/batch") && method === "POST") {
      const body = await bodyOf(init);
      const length = body.readUInt32BE(0);
      const manifest = JSON.parse(body.subarray(4, 4 + length).toString("utf8")) as {
        objects: Array<{ sha256: string; storedSize: number }>;
      };
      const unpriced = manifest.objects.filter((one) => !priced.has(one.sha256));
      if (unpriced.length) {
        refused.push(...unpriced.map((one) => one.sha256));
        return json({ error: { code: "upload_quote_invalid", message: "not part of what it asked to send" } }, 409);
      }
      for (const one of manifest.objects) held.add(one.sha256);
      return json({
        objects: manifest.objects.map((one) => ({ sha256: one.sha256, objectId: `obj-${one.sha256.slice(0, 8)}`, storedSize: one.storedSize })),
      });
    }
    if (url.pathname.endsWith("/versions") && method === "POST") {
      const files = (JSON.parse(String(init.body)) as { files: Array<{ path: string }> }).files;
      return json(
        { version: { id: randomUUID(), sequence: 1 }, manifest: { files: files.map((one) => ({ path: one.path, sha256: "" })) } },
        201,
      );
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  return { fetcher, refused };
}

test("a copy in a later section does not change the packs the plan priced", { timeout: 120_000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cbx-pack-plan-"));
  /* Text, so it is worth packing: random bytes go up as a plain batch instead. */
  const text = (label: string) => Buffer.from(`${label}
`.repeat(40));
  const first = text("the first file");
  await mkdir(path.join(folder, "a"));
  await writeFile(path.join(folder, "a", "f0000.txt"), first);
  for (let index = 1; index <= 4000; index += 1) {
    await writeFile(path.join(folder, "a", `f${String(index).padStart(4, "0")}.txt`), text(`file ${index}`));
  }
  /* Sorted after all 4,001 of them, so it lands in the second section. */
  await mkdir(path.join(folder, "z"));
  await writeFile(path.join(folder, "z", "copy-of-first.txt"), first);
  await writeFile(path.join(folder, "z", "another.txt"), text("another file"));

  const { fetcher, refused } = service();
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const uploader = new Uploader({ origin: () => "https://api.example.test", token: async () => "t" });
    const request = {
      localPath: folder,
      excluded: [],
      include: [],
      message: "two sections",
      projectName: "pack-plan",
      repositoryId,
      baseVersionId: null,
    };
    const plan = await uploader.plan(request, () => undefined);
    const result = await uploader.execute(request, plan, () => undefined);
    assert.deepEqual(refused, [], "a pack was sent that the plan had not priced");
    assert.equal(Object.keys(result.manifest).length, 4003);
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
