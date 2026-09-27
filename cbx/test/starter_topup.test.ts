import assert from "node:assert/strict";
import test from "node:test";

import {
  STARTER_IGNORE,
  STARTER_MARKER,
  missingStarterRules,
  starterAuthored,
} from "../dist/core/worktree.js";

/**
 * Recognising this application's own handiwork in a project's .gitignore.
 *
 * The starter template grows. Engine caches were added to it long after the
 * first folders were set up, and those folders can never benefit: a project
 * with any .gitignore uses that file and nothing else. A real Unity project
 * set up before the Unity rules existed went on sending its whole import
 * cache — 45,342 files of it — with the improved template sitting unused in
 * this very repository.
 *
 * The fixture below is the real file, trimmed. It is the old starter verbatim,
 * plus the three absurdly specific lines the filter screen wrote instead of a
 * rule for the folder, which is what made the problem invisible: the file
 * mentions Library, so it looks handled.
 */
const REAL_UNITY_GITIGNORE = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  "target/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "*.log",
  "models/**",
  "*.safetensors",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".cache/",
  "*.pyc",
  "IndexedDB/",
  "Local Storage/",
  "Session Storage/",
  "Service Worker/",
  "Network/",
  "GPUCache/",
  "Code Cache/",
  "blob_storage/",
  "Local State",
  "Preferences",
  "*.cbx",
  "Library/PackageCache/com.unity.collab-proxy@0b1559bcd34e/Editor/AssetOverlays/Cache/",
  "Logs/",
].join("\n");

test("recognises a file this application wrote", () => {
  assert.equal(starterAuthored(REAL_UNITY_GITIGNORE), true);
});

test("recognises a newly written one exactly, by its marker", () => {
  assert.ok(STARTER_IGNORE.includes(STARTER_MARKER));
  assert.equal(starterAuthored(STARTER_IGNORE), true);
});

test("does not claim a file somebody wrote themselves", () => {
  /*
    The whole risk of this check. Claiming authorship of a hand-written file
    would mean offering to add thirty rules to something a person curated, and
    the offer is only reasonable because it is about our own block.
  */
  const byHand = ["node_modules/", "dist/", "*.log", ".env"].join("\n");
  assert.equal(starterAuthored(byHand), false);
});

test("is not fooled by a project that merely has a browser profile in it", () => {
  /* The profile names without *.cbx: plausible for somebody to write. */
  const profile = [
    "IndexedDB/",
    "Local Storage/",
    "GPUCache/",
    "Code Cache/",
    "blob_storage/",
  ].join("\n");
  assert.equal(starterAuthored(profile), false);
});

test("names the engine rules the real file is missing", () => {
  const missing = missingStarterRules(REAL_UNITY_GITIGNORE);
  /* The one that matters: 45,342 files hang on it. */
  assert.ok(missing.includes("/[Ll]ibrary/"), "the Unity cache rule");
  assert.ok(missing.includes("/[Uu]ser[Ss]ettings/"));
  assert.ok(missing.includes(".godot/"));
  assert.ok(missing.includes("obj/"));
  /* And it does not re-offer what is already there. */
  assert.ok(!missing.includes("node_modules/"));
  assert.ok(!missing.includes("*.cbx"));
});

test("has nothing to add to the current template", () => {
  assert.deepEqual(missingStarterRules(STARTER_IGNORE), []);
});

test("ignores comments and blank lines on both sides", () => {
  const noisy = "# mine\n\n   node_modules/   \n\n# and\n*.log\n";
  const missing = missingStarterRules(noisy);
  assert.ok(!missing.includes("node_modules/"));
  assert.ok(!missing.includes("*.log"));
  assert.ok(!missing.some((line) => line.startsWith("#") || line === ""));
});
