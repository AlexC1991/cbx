import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedManifestDigests,
  retainedBasePaths,
} from "../dist/shared/publication.js";

test("a partial save retains every unselected base path", () => {
  const kept = retainedBasePaths(
    ["src/a.ts", "src/b.ts", "assets/model.bin"],
    new Set(["src/a.ts"]),
  );
  assert.deepEqual(kept, ["assets/model.bin", "src/b.ts"]);
});

test("a selected deletion removes only that path from the candidate", () => {
  const kept = retainedBasePaths(
    ["deleted.txt", "kept.txt", "remote-only.txt"],
    new Set(["deleted.txt"]),
  );
  assert.deepEqual(kept, ["kept.txt", "remote-only.txt"]);
});

test("a clean server merge replaces the candidate with the accepted snapshot", () => {
  assert.deepEqual(
    acceptedManifestDigests([
      { path: "mine.txt", sha256: "mine" },
      { path: "theirs.txt", sha256: "theirs" },
      { path: "missing-digest.txt" },
    ]),
    { "mine.txt": "mine", "theirs.txt": "theirs" },
  );
});
