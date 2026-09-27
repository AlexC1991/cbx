import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A switch must not swallow the argument after it.
 *
 * `cbx take-down 1 --yes my-project` read "my-project" as the value of
 * `--yes`, then reported that `--yes` had not been given — having also
 * consumed the argument saying which project. Every boolean flag followed by
 * a positional had the same fault, so this is checked through the real
 * binary rather than a copy of the parser.
 */
/*
  A config folder of its own. Run without one, the real binary read the links
  of whoever ran the tests — and a command that looks up its folder's link is
  also what migrates the old links file, so a test run was quietly upgrading
  the developer's own configuration.
*/
const home = mkdtempSync(path.join(tmpdir(), "coderook-flags-"));
const run = (args: string[]) =>
  execFileSync(process.execPath, ["dist/cli/src/cli.js", ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEROOK_TOKEN: "", CODEROOK_CONFIG_DIR: home, NO_COLOR: "1" },
  });

test("a declared switch does not consume the next argument", () => {
  /* Reaching "which project" proves --yes was read as a switch: the old
     parser stopped earlier, complaining that --yes was missing. */
  let output = "";
  try {
    output = run(["take-down", "1", "--yes", "not-a-real-project"]);
  } catch (error) {
    output = String((error as { stdout?: string; stderr?: string }).stdout ?? "") +
      String((error as { stderr?: string }).stderr ?? "");
  }
  assert.ok(
    !output.includes("Add --yes when you are sure"),
    `--yes was not read as a switch: ${output}`,
  );
});

test("a declared value flag still takes its value", () => {
  let output = "";
  try {
    output = run(["mark", "1", "--name", "v9", "not-a-real-project"]);
  } catch (error) {
    output = String((error as { stdout?: string; stderr?: string }).stdout ?? "") +
      String((error as { stderr?: string }).stderr ?? "");
  }
  assert.ok(!output.includes("v9 is not"), output);
});

/**
 * `--no-ship` is one flag, not a negation the parser knows about.
 *
 * The parser strips leading dashes and keeps the rest of the word, so
 * `--no-ship` arrives as the flag "no-ship" and takes the action name after
 * it. Worth checking rather than assuming: a parser that treated `--no-`
 * as a prefix would read this as `--ship false` and turn shipping on.
 */
test("--no-ship takes the name after it", () => {
  let output = "";
  try {
    output = run(["actions", "--no-ship", "Build", "not-a-real-project"]);
  } catch (error) {
    output = String((error as { stdout?: string; stderr?: string }).stdout ?? "") +
      String((error as { stderr?: string }).stderr ?? "");
  }
  /* Reaching the project lookup proves "Build" was read as the flag's value
     rather than left sitting in the positions as a project name. */
  assert.ok(!output.includes("Which action?"), output);
});
