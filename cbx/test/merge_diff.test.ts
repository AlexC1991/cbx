import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  conflictDraft,
  diffLines,
  foldUnchanged,
  hasConflictMarkers,
  linesOf,
} from "../src/shared/merge_diff.ts";

/**
 * Reading a conflict, rather than guessing at one.
 *
 * The merge window offered four buttons above nothing at all: you were asked
 * which side wins for a file you could not see. The property that matters is
 * that both sides are accounted for exactly — a diff that quietly drops a
 * line would have somebody publish a file with a line missing, and there is
 * nothing on the screen that would show it.
 */
describe("laying two sides out", () => {
  test("identical files are all agreement", () => {
    const diff = diffLines("a\nb\nc\n", "a\nb\nc\n");
    assert.equal(diff.length, 3);
    assert.ok(diff.every((line) => line.side === "same"));
  });

  test("every line of both sides survives, in order", () => {
    const target = "one\ntwo\nthree\nfour\n";
    const candidate = "one\ntwo and a half\nthree\nfive\n";
    const diff = diffLines(target, candidate);

    assert.deepEqual(
      diff.filter((line) => line.side !== "candidate").map((line) => line.text),
      linesOf(target),
    );
    assert.deepEqual(
      diff.filter((line) => line.side !== "target").map((line) => line.text),
      linesOf(candidate),
    );
  });

  test("an empty side is all of the other one", () => {
    assert.deepEqual(
      diffLines("", "only\n").map((line) => line.side),
      ["candidate"],
    );
    assert.deepEqual(diffLines("", ""), []);
  });

  test("windows line endings read the same as unix ones", () => {
    /*
      Two people on different machines are exactly who this window is for,
      and a diff that called every line of a CRLF file changed would report a
      whole-file conflict where there is none.
    */
    assert.ok(diffLines("a\r\nb\r\n", "a\nb\n").every((line) => line.side === "same"));
  });
});

describe("folding what nobody needs to read", () => {
  test("long agreement becomes a gap that says how much it hid", () => {
    const same = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const chunks = foldUnchanged(
      diffLines([...same, "mine"].join("\n"), [...same, "theirs"].join("\n")),
      3,
    );
    const gaps = chunks.filter((chunk) => chunk.kind === "gap");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.kind === "gap" ? gaps[0]!.skipped : -1, 37);
  });

  test("a file with no differences is shown whole rather than folded away", () => {
    const chunks = foldUnchanged(diffLines("a\nb\n", "a\nb\n"));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.kind, "lines");
  });

  test("nothing is lost by folding except inside a gap", () => {
    const target = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const candidate = target.replace("l15", "changed");
    const all = diffLines(target, candidate);
    const chunks = foldUnchanged(all, 2);
    const kept = chunks.reduce(
      (total, chunk) => total + (chunk.kind === "lines" ? chunk.lines.length : 0),
      0,
    );
    const hidden = chunks.reduce(
      (total, chunk) => total + (chunk.kind === "gap" ? chunk.skipped : 0),
      0,
    );
    assert.equal(kept + hidden, all.length);
  });
});

describe("settling it by writing the answer", () => {
  test("the draft keeps agreement once and stacks the rest", () => {
    const draft = conflictDraft("shared\nmine\n", "shared\ntheirs\n");
    assert.equal(draft.split("\n").filter((line) => line === "shared").length, 1);
    assert.ok(draft.includes("mine") && draft.includes("theirs"));
    assert.ok(/^<{7} /m.test(draft));
  });

  test("a draft of two agreeing files carries no markers at all", () => {
    assert.equal(conflictDraft("same\n", "same\n"), "same");
  });

  test("markers left in an edit are caught before it is sent", () => {
    /*
      The failure this exists for: somebody resolves the top half of the
      draft, misses the bottom, and publishes a file with `>>>>>>>` in it.
    */
    assert.equal(hasConflictMarkers(conflictDraft("a\n", "b\n")), true);
    assert.equal(hasConflictMarkers("clean\nfile\n"), false);
    assert.equal(hasConflictMarkers("mentions <<<<<<< in passing"), false);
  });
});
