/*
  What this build tells the service it is.

  Not cosmetic: the service refuses operations an older client cannot do
  safely, so a build that misstates its version is treated as ancient. The git
  remote helper passed its own name where the version belongs and announced
  itself as `cli/git-remote` — the service could make nothing of it, applied
  the floor, and refused to serve files. `git push` was unaffected, so it only
  appeared on the way back, as a demand to update to a release far older than
  the one running.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { VERSION } from "../src/version.ts";

test("the declared version is a real version, not a name", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/, `declared "${VERSION}"`);
});

test("it matches the package actually being published", () => {
  const published = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
  ) as { version: string };
  assert.equal(VERSION, published.version);
});

test("nothing declares a client with a hand-written string", () => {
  // Both entry points must go through the shared constant. A literal here is
  // how the helper came to call itself "git-remote" in the first place.
  for (const file of ["../src/cli.ts", "../src/git_remote.ts"]) {
    const source = readFileSync(path.resolve(import.meta.dirname, file), "utf8");
    const calls = [...source.matchAll(/declareClient\([^)]*\)/g)].map((m) => m[0]);
    for (const call of calls) {
      assert.ok(
        call.includes("VERSION"),
        `${file} declares a client without the shared version: ${call}`,
      );
    }
  }
});
