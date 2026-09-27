/**
 * A file deleted here, and a save that did not send the deletion.
 *
 * A plain save adds and updates, so the deleted file stays in the version. It
 * used to drop out of the folder's own record all the same — that record was
 * built only from what is on disk — and the next `cbx status` then saw the
 * version holding a file this folder did not, called it "behind", and told the
 * person to run `cbx get`, which brought back the file they had deleted.
 * `--sync` could not send the deletion either: by the record's account the
 * file had never been here. It happened to CodeBox's own
 * `ExcludedReview.tsx` on the first save made of this repository.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** The version this folder is based on. */
const BASE: Record<string, string> = {
  "a.txt": "alpha\n",
  /* Was here, and has since been deleted. */
  "gone.txt": "was here\n",
  /* Somebody else's, merged into the version, never fetched here. */
  "merged.txt": "theirs\n",
};

function fakeService() {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.pathname === "/health") {
      return json({ features: [], contentEncodings: ["identity"] });
    }
    if (url.pathname.endsWith(`/versions/${baseVersionId}/files`)) {
      return json({
        files: Object.entries(BASE).map(([file, body]) => ({
          path: file,
          objectId: `obj-${file}`,
          sha256: sha(body),
          sourceSize: body.length,
          storedSize: body.length,
          mediaType: "text/plain",
        })),
      });
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
        objects: Array<{ sha256: string; storedSize: number }>;
      };
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
            exempt: true,
            stage: 1,
            unlockedPercent: 100,
            unlockedBytes: 1e9,
            chargedBytes: 0,
            reservedBytes: 0,
            remainingBytes: 1e9,
            periodStart: "2026-09-01T00:00:00.000Z",
            periodEnd: "2026-10-01T00:00:00.000Z",
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
      return json({ objectId: `obj-new`, size: body.byteLength, storedSize: body.byteLength }, 201);
    }
    if (url.pathname.endsWith("/versions") && method === "POST") {
      /* The version is what was sent: every file named, with its digest. */
      const sent = JSON.parse(String(init.body)) as {
        files?: Array<{ path: string; sha256?: string }>;
        manifest?: { files?: Array<{ path: string; sha256?: string }> };
      };
      const files = sent.manifest?.files ?? sent.files ?? [];
      return json(
        {
          version: { id: crypto.randomUUID(), sequence: 2 },
          manifest: {
            files: files.map((one) => ({
              path: one.path,
              sha256: one.sha256 ?? sha(BASE[one.path] ?? ""),
            })),
          },
        },
        201,
      );
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
}

async function save(deletions: string[] = []) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "coderook-deleted-"));
  await writeFile(path.join(folder, "a.txt"), BASE["a.txt"]!);
  await writeFile(path.join(folder, "new.txt"), "new\n");
  const original = globalThis.fetch;
  globalThis.fetch = fakeService();
  try {
    return await new Uploader({
      origin: () => "https://api.example.test",
      token: async () => "test-token",
    }).run(
      {
        localPath: folder,
        /* As every caller sends it: a deletion is also a selected path. */
        include: ["new.txt", ...deletions],
        deletions,
        message: "a save",
        projectName: "deleted",
        repositoryId,
        baseVersionId,
        /* What this folder held after its last save: a.txt and gone.txt. */
        known: { "a.txt": sha(BASE["a.txt"]!), "gone.txt": sha(BASE["gone.txt"]!) },
      },
      () => undefined,
    );
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
}

test("a plain save keeps a deleted file in the folder's record as well as the version", async () => {
  const result = await save();
  assert.ok("gone.txt" in result.manifest, "a plain save carries it forward");
  assert.equal(
    result.local["gone.txt"],
    sha(BASE["gone.txt"]!),
    "so the next status reads it as deleted here, not as somebody else's file",
  );
});

test("a file that was never here stays behind", async () => {
  /* The case "behind" exists for: merged in by somebody else, never fetched. */
  const result = await save();
  assert.ok("merged.txt" in result.manifest);
  assert.ok(!("merged.txt" in result.local), "it is not something this folder holds");
});

test("a save with the deletion leaves it out of both", async () => {
  const result = await save(["gone.txt"]);
  assert.ok(!("gone.txt" in result.manifest));
  assert.ok(!("gone.txt" in result.local));
});

test("what is here is recorded as it is", async () => {
  const result = await save();
  assert.equal(result.local["a.txt"], sha(BASE["a.txt"]!));
  assert.equal(result.local["new.txt"], sha("new\n"));
});
