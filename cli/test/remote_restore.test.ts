import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { projectPath, selectFiles } from "../dist/cli/src/remote_restore.js";

/**
 * `cbx restore` in a linked folder (it used to say "No history here").
 * The network half is checked against the live service; these pin down
 * which files a typed path means.
 */

const root = path.resolve("/work/game");
const file = (p: string) => ({ path: p, sha256: "x", sourceSize: 1 });

test("typed paths become project paths, from the root or a subfolder", () => {
  assert.equal(projectPath(root, root, "src/player.ts"), "src/player.ts");
  assert.equal(projectPath(root, path.join(root, "src"), "player.ts"), "src/player.ts");
  assert.equal(projectPath(root, root, "assets/"), "assets");
  assert.equal(projectPath(root, path.join(root, "src"), ".."), "");
  assert.equal(projectPath(root, root, "../other/file.txt"), null);
});

test("a folder path covers what is under it and nothing that merely shares a prefix", () => {
  const files = [file("assets/a.png"), file("assets/b/c.png"), file("assets-old/d.png"), file("readme.md")];
  assert.deepEqual(selectFiles(files, ["assets"]).map((f) => f.path), ["assets/a.png", "assets/b/c.png"]);
  assert.deepEqual(selectFiles(files, ["readme.md"]).map((f) => f.path), ["readme.md"]);
  assert.equal(selectFiles(files, []).length, 4);
  assert.equal(selectFiles(files, [""]).length, 4);
});
