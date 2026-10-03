/**
 * Bytes that arrive still gzip-compressed are recovered, and nothing else is.
 *
 * A service that recorded an object's encoding wrongly served the stored gzip
 * as though it were the file, and clones of desktop3d could never finish. The
 * bytes were a gzip of exactly the original. A client that checks digests can
 * tell that case apart from real damage, so it does, for whole files and for
 * the pieces of a large one; a gzip of anything else is still refused.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { Downloader } from "../dist/core/download.js";

const digest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const credentials = { origin: () => "https://bench.invalid", token: async () => "t" };

async function serving(routes: Record<string, Buffer>, run: (folder: string) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const folder = await mkdtemp(path.join(tmpdir(), "cbx-gzip-"));
  globalThis.fetch = async (input) => {
    const route = new URL(String(input)).pathname;
    for (const [suffix, body] of Object.entries(routes)) {
      if (route.endsWith(suffix)) return new Response(body);
    }
    throw new Error(`unexpected test route ${route}`);
  };
  try {
    await run(folder);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, { recursive: true, force: true });
  }
}

test("a whole file served as its gzip is recovered and reported", async () => {
  const original = Buffer.from("a PNG's worth of bytes\n".repeat(200));
  await serving({ "/objects/object-1": gzipSync(original) }, async (folder) => {
    const downloader = new Downloader(credentials);
    const target = path.join(folder, "sheet.png");
    const got = await downloader.fileTo(
      "repository-1",
      "version-1",
      { path: "assets/sheet.png", objectId: "object-1", sha256: digest(original), sourceSize: original.length },
      target,
    );
    assert.equal(got, digest(original));
    assert.ok((await readFile(target)).equals(original));
    assert.deepEqual(downloader.recoveredFromGzip, ["assets/sheet.png"]);
  });
});

test("a gzip of something else is still a damaged file", async () => {
  const original = Buffer.from("what the file should be\n".repeat(50));
  await serving({ "/objects/object-1": gzipSync(Buffer.from("something else entirely")) }, async (folder) => {
    const downloader = new Downloader(credentials);
    const got = await downloader.fileTo(
      "repository-1",
      "version-1",
      { path: "a.bin", objectId: "object-1", sha256: digest(original), sourceSize: original.length },
      path.join(folder, "a.bin"),
    );
    assert.notEqual(got, digest(original));
    assert.deepEqual(downloader.recoveredFromGzip, []);
  });
});

test("a piece of a large file served as its gzip is recovered", async () => {
  const one = Buffer.from("first piece ".repeat(300));
  const two = Buffer.from("second piece ".repeat(300));
  const whole = Buffer.concat([one, two]);
  await serving(
    { "/objects/piece-1": one, "/objects/piece-2": gzipSync(two) },
    async (folder) => {
      const downloader = new Downloader(credentials);
      const target = path.join(folder, "big.bin");
      const got = await downloader.fileTo(
        "repository-1",
        "version-1",
        {
          path: "big.bin",
          sha256: digest(whole),
          sourceSize: whole.length,
          chunks: [
            { objectId: "piece-1", sha256: digest(one), sourceSize: one.length },
            { objectId: "piece-2", sha256: digest(two), sourceSize: two.length },
          ],
        },
        target,
      );
      assert.equal(got, digest(whole));
      assert.ok((await readFile(target)).equals(whole));
      assert.deepEqual(downloader.recoveredFromGzip, ["big.bin"]);
    },
  );
});
