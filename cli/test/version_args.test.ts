import assert from "node:assert/strict";
import test from "node:test";

const { split } = await import("../dist/cli/src/version_commands.js");

/**
 * `[n] [project]` are both optional and both positional, so the only thing
 * separating `cbx undo 41` from `cbx undo blog` is the shape of the word.
 *
 * This is here because it shipped wrong: every one of these commands read the
 * first word as a save number, so naming a project and nothing else got
 * "Which project?" from a command that had just been handed one.
 */
const of = (positional: string[], flags: [string, unknown][] = []) =>
  split({ positional, flags: new Map(flags) } as never);

test("a bare number is the save, not the project", () => {
  assert.deepEqual(of(["41"]), { n: "41" });
  assert.deepEqual(of(["v41"]), { n: "v41" });
});

test("a bare name is the project, not the save", () => {
  assert.deepEqual(of(["blog"]), { project: "blog" });
  assert.deepEqual(of(["someone/blog"]), { project: "someone/blog" });
});

test("both, in the documented order", () => {
  assert.deepEqual(of(["41", "someone/blog"]), { n: "41", project: "someone/blog" });
});

test("neither leaves both open, so the linked folder answers", () => {
  assert.deepEqual(of([]), { project: undefined });
});

test("--project names the project, freeing the first word to be the save", () => {
  assert.deepEqual(of(["41"], [["project", "9"]]), { n: "41", project: "9" });
  assert.deepEqual(of([], [["p", "blog"]]), { project: "blog" });
});

test("a flag that arrived without a value is not a project name", () => {
  assert.deepEqual(of(["blog"], [["project", true]]), { project: "blog" });
});
