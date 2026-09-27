import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Downloader } from "../dist/core/download.js";

const digest = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex");

test("a restore fetches each solid pack once and ordinary files by object id", async () => {
  const first = Buffer.from("first packed file\n");
  const second = Buffer.from("second packed file\n");
  const pack = Buffer.concat([first, second]);
  const ordinary = Buffer.from("ordinary file\n");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(tmpdir(), "coderook-download-"));

  globalThis.fetch = async (input) => {
    const url = String(input);
    const route = new URL(url).pathname;
    calls.push(route);
    if (route.endsWith("/versions/version-1/files")) {
      return Response.json({
        files: [
          {
            path: "packed/first.txt",
            sha256: digest(first),
            sourceSize: first.byteLength,
            pack: { objectId: "pack-1", offset: 0, length: first.byteLength },
          },
          {
            path: "packed/second.txt",
            sha256: digest(second),
            sourceSize: second.byteLength,
            pack: {
              objectId: "pack-1",
              offset: first.byteLength,
              length: second.byteLength,
            },
          },
          {
            path: "ordinary.txt",
            objectId: "object-1",
            sha256: digest(ordinary),
            sourceSize: ordinary.byteLength,
          },
        ],
      });
    }
    if (route.endsWith("/objects/pack-1")) {
      return new Response(pack, {
        headers: { "x-coderook-sha256": digest(pack) },
      });
    }
    if (route.endsWith("/objects/object-1")) return new Response(ordinary);
    throw new Error(`unexpected test route ${route}`);
  };

  try {
    const downloader = new Downloader({
      origin: () => "https://bench.invalid",
      token: async () => "test-token",
    });
    const restored = await downloader.run(
      "repository-1",
      "version-1",
      root,
      () => undefined,
    );

    assert.equal(restored.files, 3);
    assert.equal(await readFile(path.join(root, "packed", "first.txt"), "utf8"), first.toString());
    assert.equal(await readFile(path.join(root, "packed", "second.txt"), "utf8"), second.toString());
    assert.equal(await readFile(path.join(root, "ordinary.txt"), "utf8"), ordinary.toString());
    assert.equal(calls.filter((one) => one.endsWith("/objects/pack-1")).length, 1);
    assert.equal(calls.filter((one) => one.includes("/versions/version-1/file")).length, 1);
    assert.equal(calls.some((one) => one.endsWith("/version-1/file")), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("a bounded Version verification fetches each pack once and leaves no project copy", async () => {
  const first = Buffer.from("first packed file\n");
  const second = Buffer.from("second packed file\n");
  const pack = Buffer.concat([first, second]);
  const ordinary = Buffer.from("ordinary file\n");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(tmpdir(), "coderook-verify-"));

  globalThis.fetch = async (input) => {
    const route = new URL(String(input)).pathname;
    calls.push(route);
    if (route.endsWith("/versions/version-1/files")) {
      return Response.json({ files: [
        { path: "packed/first.txt", sha256: digest(first), sourceSize: first.byteLength,
          pack: { objectId: "pack-1", offset: 0, length: first.byteLength } },
        { path: "packed/second.txt", sha256: digest(second), sourceSize: second.byteLength,
          pack: { objectId: "pack-1", offset: first.byteLength, length: second.byteLength } },
        { path: "ordinary.txt", objectId: "object-1", sha256: digest(ordinary), sourceSize: ordinary.byteLength },
      ] });
    }
    if (route.endsWith("/objects/pack-1")) {
      return new Response(pack, { headers: { "x-coderook-sha256": digest(pack) } });
    }
    if (route.endsWith("/objects/object-1")) return new Response(ordinary);
    throw new Error(`unexpected test route ${route}`);
  };

  try {
    const downloader = new Downloader({
      origin: () => "https://bench.invalid",
      token: async () => "test-token",
    });
    const verified = await downloader.verify("repository-1", "version-1", path.join(root, "scratch"), () => undefined);
    assert.equal(verified.files, 3);
    assert.equal(verified.bytes, first.byteLength + second.byteLength + ordinary.byteLength);
    assert.equal(verified.manifest["ordinary.txt"], digest(ordinary));
    assert.equal(calls.filter((one) => one.endsWith("/objects/pack-1")).length, 1);
    await assert.rejects(readFile(path.join(root, "scratch", "current-file.partial")), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("a large file-list read retries when its response body is interrupted", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"files":['));
          controller.error(new TypeError("connection closed during body"));
        },
      }));
    }
    return Response.json({
      files: [{
        path: "recovered.txt",
        objectId: "object-2",
        sha256: digest("recovered"),
        sourceSize: 9,
      }],
    });
  };

  try {
    const downloader = new Downloader({
      origin: () => "https://bench.invalid",
      token: async () => "test-token",
    });
    const files = await downloader.files("repository-1", "version-1");
    assert.equal(attempts, 2);
    assert.equal(files[0]?.path, "recovered.txt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
