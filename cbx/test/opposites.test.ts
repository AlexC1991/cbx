/**
 * A folder has one answer in the rules file, not two.
 *
 * Every writer here appends, because a keep has to come after whatever would
 * take the file. So a later answer always won — and the earlier one always
 * stayed. A real project's .gitignore ended with:
 *
 *   # Always include
 *   !output/
 *
 *   # Suggested for this folder, and accepted.
 *   output/
 *
 * Right to a matcher, since the last line wins, and to anybody reading it a
 * file that says both things. It got there because the size prompt asked about
 * a folder somebody had already marked "always include", and accepting it left
 * the keep behind.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acceptSuggestions,
  keptTargets,
  missingStarterRules,
  moveRule,
  ruleTarget,
  withoutOpposites,
} from "../dist/core/worktree.js";

const REAL = [
  "*.cbx",
  "",
  "# Always include",
  "!output/",
  "",
  "# Suggested for this folder, and accepted.",
  "output/",
  "",
].join("\n");

async function folder(gitignore: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-opposites-"));
  await mkdir(path.join(root, "output"), { recursive: true });
  await writeFile(path.join(root, "output", "model.gguf"), "weights");
  await writeFile(path.join(root, "main.py"), "print(1)\n");
  await writeFile(path.join(root, ".gitignore"), gitignore);
  return root;
}

const ignoreFile = (root: string) => readFile(path.join(root, ".gitignore"), "utf8");

test("names the thing a line is about, however it was spelt", () => {
  for (const spelling of ["output/", "/output/", "!output/", "  !/output/  ", "output"]) {
    assert.equal(ruleTarget(spelling), "output", spelling);
  }
});

test("removes the opposite answer and the heading it leaves empty", () => {
  const settled = withoutOpposites(REAL, "output/");
  assert.equal(
    settled,
    ["*.cbx", "", "# Suggested for this folder, and accepted.", "output/", ""].join("\n"),
  );
});

test("leaves a broader rule alone, because that is what the keep is for", () => {
  /* `*.log` is not about important.log; without it the keep means nothing. */
  const text = "*.log\n\n# Always include\n!important.log\n";
  assert.equal(withoutOpposites(text, "!important.log"), text);
});

test("keeps the heading when something else is still under it", () => {
  const text = "# Always include\n!output/\n!notes/\n";
  assert.equal(withoutOpposites(text, "output/"), "# Always include\n!notes/\n");
});

test("returns the file untouched when there is nothing to settle", () => {
  const text = "node_modules/\r\n\r\n# Always include\r\n!notes/\r\n";
  assert.equal(withoutOpposites(text, "output/"), text, "line endings included");
});

test("accepting a suggestion replaces the keep it overrules", async () => {
  const root = await folder("*.cbx\n\n# Always include\n!output/\n");
  await acceptSuggestions(root, ["output/"], []);
  const written = await ignoreFile(root);
  assert.ok(!written.includes("!output/"), written);
  assert.ok(!written.includes("# Always include"), "no heading over nothing");
  assert.match(written, /# Suggested for this folder, and accepted\.\noutput\//);
});

test("accepting a folder already written below its keep settles the file", async () => {
  /* The state the real project was left in: the rule is there, so nothing new
     is added, but the contradiction above it still has to go. */
  const root = await folder(REAL);
  await acceptSuggestions(root, ["output/"], []);
  const written = await ignoreFile(root);
  assert.ok(!written.includes("!output/"), written);
  assert.equal(written.match(/^output\/$/gm)?.length, 1, "written once");
});

test("a starter top-up never overrules something kept on purpose", async () => {
  /*
    Nobody chose the starter lines one by one. Appended after a keep, `.idea/`
    would win and take out the folder somebody said to always include.
  */
  const root = await folder("# Always include\n!.idea/\n");
  await acceptSuggestions(root, [], [".idea/", "__pycache__/"]);
  const written = await ignoreFile(root);
  assert.ok(written.includes("!.idea/"), "the keep stands");
  assert.ok(!/^\.idea\/$/m.test(written), `.idea/ was added after it:\n${written}`);
  assert.ok(written.includes("__pycache__/"), "the rest still arrives");
});

test("a kept folder is not reported as a missing starter rule", () => {
  const text = "*.cbx\n\n# Always include\n!.idea/\n";
  const missing = missingStarterRules(text, ".idea/\n__pycache__/\n");
  assert.deepEqual(missing, ["__pycache__/"]);
});

test("the filter screen replaces a keep instead of stacking under it", async () => {
  const root = await folder("*.cbx\n\n# Always include\n!output/\n");
  await moveRule(root, "output", false);
  const written = await ignoreFile(root);
  assert.ok(!written.includes("!output/"), written);
  assert.ok(/^output\/$/m.test(written));
});

test("and keeping a folder replaces the line that left it out", async () => {
  const root = await folder("*.cbx\n\n# Left out from the filter screen\noutput/\n");
  await moveRule(root, "output", true);
  const written = await ignoreFile(root);
  assert.ok(!/^output\/$/m.test(written), written);
  assert.ok(written.includes("!output/"));
  assert.ok(!written.includes("# Left out from the filter screen"), "no heading over nothing");
});

test("knows what a file explicitly keeps", () => {
  const kept = keptTargets("*.log\n!important.log\n# !not-a-rule\n!/output/\n");
  assert.deepEqual([...kept].sort(), ["important.log", "output"]);
});
