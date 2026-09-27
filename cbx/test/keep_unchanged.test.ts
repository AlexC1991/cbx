/**
 * A save sends what changed, and names everything else as it already was.
 *
 * Both callers select the whole folder — the command line with an empty
 * exclusion list, because its list of changes stops at twenty thousand — and
 * every selected file used to be a file to send. Small files are stored inside
 * packs, where the service cannot recognise one as already held, so each save
 * packed and sent all of them again. CodeBox's own saves sent 3.1 MB across
 * 1,025 files to record a change to eight.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Uploader } from "../dist/core/upload.js";

const repositoryId = "00000000-0000-4000-8000-000000000111";
const baseVersionId = "00000000-0000-4000-8000-0000000000b0";
const quoteId = "00000000-0000-4000-8000-000000000222";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Forty small files, all stored as slices of one pack in the base version. */
const BASE: Record<string, string> = Object.fromEntries(
  Array.from({ length: 40 }, (_, at) => [
    `src/file-${String(at).padStart(2, "0")}.ts`,
    `export const value${at} = ${at};\n`.repeat(20),
  ]),
);

type Seen = {
  quoted: string[];
  putBodies: number;
  putBytes: number;
  published: Array<Record<string, unknown>>;
};

function fakeService(seen: Seen) {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.pathname === "/health") {
      return json({ features: ["solid-packs"], contentEncodings: ["identity", "gzip"] });
    }
    if (url.pathname.endsWith(`/versions/${baseVersionId}/files`)) {
      let offset = 0;
      return json({
        files: Object.entries(BASE).map(([file, body]) => {
          const row = {
            path: file,
            objectId: "",
            pack: { objectId: "pack-base", offset, length: body.length },
            sha256: sha(body),
            sourceSize: body.length,
            storedSize: body.length,
            mediaType: "text/plain",
          };
          offset += body.length;
          return row;
        }),
      });
    }
    if (url.pathname.endsWith("/stored")) {
      return json(method === "POST" ? { stored: {} } : { stored: false });
    }
    if (url.pathname.endsWith("/uploads/preflight")) {
      const request = JSON.parse(String(init.body)) as {
        sourceBytes: number;
        objects: Array<{ sha256: string; storedSize: number }>;
      };
      seen.quoted.push(...request.objects.map((one) => one.sha256));
      return json(
        {
          quoteId,
          repositoryId,
          sourceBytes: request.sourceBytes,
          excludedBytes: 0,
          compactedBytes: 0,
          reusableBytes: 0,
          chargeableBytes: 0,
          storage: { usedBytes: 0, quotaBytes: 1e9, remainingBytes: 1e9 },
          allowance: {
            exempt: true, stage: 1, unlockedPercent: 100, unlockedBytes: 1e9,
            chargedBytes: 0, reservedBytes: 0, remainingBytes: 1e9,
            periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z",
            nextUnlockAt: null,
          },
          expiresAt: "2026-09-30T00:00:00.000Z",
          objects: Object.fromEntries(
            request.objects.map((one) => [
              one.sha256,
              { objectId: `obj-${one.sha256.slice(0, 8)}`, storedSize: one.storedSize, needsUpload: true },
            ]),
          ),
        },
        201,
      );
    }
    if (method === "PUT" && url.pathname.includes("/objects/")) {
      const body = init.body as Uint8Array;
      seen.putBodies += 1;
      seen.putBytes += body.byteLength;
      return json({ objectId: `obj-${seen.putBodies}`, size: body.byteLength, storedSize: body.byteLength }, 201);
    }
    if (url.pathname.endsWith("/versions") && method === "POST") {
      const sent = JSON.parse(String(init.body)) as {
        files?: Array<Record<string, unknown>>;
        manifest?: { files?: Array<Record<string, unknown>> };
      };
      const files = sent.manifest?.files ?? sent.files ?? [];
      seen.published.push(...files);
      return json(
        {
          version: { id: crypto.randomUUID(), sequence: 2 },
          manifest: {
            files: files.map((one) => ({
              path: one.path,
              sha256: (one.sha256 as string | undefined) ?? sha(BASE[one.path as string] ?? ""),
            })),
          },
        },
        201,
      );
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
}

async function save(change: (folder: string) => Promise<void>, deletions: string[] = []) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "coderook-kept-"));
  await mkdir(path.join(folder, "src"), { recursive: true });
  for (const [file, body] of Object.entries(BASE)) await writeFile(path.join(folder, file), body);
  await change(folder);
  const seen: Seen = { quoted: [], putBodies: 0, putBytes: 0, published: [] };
  const original = globalThis.fetch;
  globalThis.fetch = fakeService(seen);
  try {
    const result = await new Uploader({
      origin: () => "https://api.example.test",
      token: async () => "test-token",
    }).run(
      {
        localPath: folder,
        /* Everything, the way both callers select it. */
        excluded: [],
        include: [],
        deletions,
        message: "a save",
        projectName: "kept",
        repositoryId,
        baseVersionId,
      },
      () => undefined,
    );
    return { result, seen };
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
}

const changed = "src/file-07.ts";

test("one changed file sends one file, not the whole pack again", async () => {
  const { seen } = await save((folder) =>
    writeFile(path.join(folder, changed), "export const changed = true;\n"),
  );
  assert.equal(seen.quoted.length, 1, `quoted ${seen.quoted.length} objects for one change`);
  assert.equal(seen.putBodies, 1);
  assert.ok(seen.putBytes < 200, `${seen.putBytes} bytes sent for a 29-byte change`);
});

test("the unchanged files are named as the slices they already are", async () => {
  const { seen } = await save((folder) =>
    writeFile(path.join(folder, changed), "export const changed = true;\n"),
  );
  assert.equal(seen.published.length, 40, "a version still names every file");
  const kept = seen.published.filter((one) => one.path !== changed);
  for (const one of kept) {
    const pack = one.pack as { packObjectId?: string; objectId?: string } | undefined;
    assert.equal(
      pack?.packObjectId ?? pack?.objectId,
      "pack-base",
      `${String(one.path)} points somewhere new`,
    );
  }
});

test("a save that only deletes sends nothing at all", async () => {
  const { seen, result } = await save(
    (folder) => rm(path.join(folder, changed)),
    [changed],
  );
  assert.equal(seen.putBodies, 0);
  assert.ok(!(changed in result.manifest));
  assert.equal(Object.keys(result.manifest).length, 39);
});
