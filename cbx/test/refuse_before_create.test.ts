/**
 * A first save refused over a file it cannot read leaves nothing behind.
 *
 * Found by saving a folder holding one file another program had open and one
 * this account may not read. The save was refused — rightly — with "Nothing
 * was changed on your account", but the plan had already created the
 * project, so an empty one was left on the account and the next save from
 * that folder asked whether to link to it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Uploader } from "../dist/core/upload.js";

test("an unreadable chosen file refuses the save before a project exists", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cbx-refuse-early-"));
  await writeFile(path.join(folder, "a.txt"), "readable\n");
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    asked.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ features: [], contentEncodings: ["identity"] }), { status: 200 });
    }
    throw new Error(`Unexpected ${init.method ?? "GET"} ${url.pathname}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      new Uploader({ origin: () => "https://api.example.test", token: async () => "t" }).plan(
        {
          localPath: folder,
          /* Chosen, and not there to be read when the save looks. */
          include: ["a.txt", "held-open.bin"],
          message: "first save",
          projectName: "refused",
          repositoryId: null,
          baseVersionId: null,
        },
        () => undefined,
      ),
      /could not be included, so nothing was saved: held-open\.bin/,
    );
    assert.ok(
      !asked.some((call) => call.startsWith("POST /v1/repositories")),
      `the project was created anyway: ${asked.join(", ")}`,
    );
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
