/*
  The decisions the git remote helper makes before it touches a network.

  Ordering is the one worth the most care. `git fast-import` refuses a mark it
  has not been given yet, so emitting a commit before one of its parents fails
  loudly — but only on a history shaped the right way to expose it, which a
  straight line never is. These build the shapes that do.
*/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commitFromMessage,
  MESSAGE_LIMIT,
  messageWithCommit,
  messageWithoutMarker,
  parseRemoteUrl,
  quotePath,
  refPlacements,
  tagOf,
  historyLeftOut,
  versionsInOrder,
  withinDepth,
} from "../src/git_history.ts";

type V = { id: string; parentVersionIds: string[] };
const v = (id: string, ...parents: string[]): V => ({
  id,
  parentVersionIds: parents,
});

/** Every parent must appear before the child that names it. */
function assertParentsFirst(order: V[]): void {
  const seen = new Set<string>();
  const present = new Set(order.map((entry) => entry.id));
  for (const entry of order) {
    for (const parent of entry.parentVersionIds) {
      if (!present.has(parent)) continue; // outside the requested history
      assert.ok(
        seen.has(parent),
        `${entry.id} was emitted before its parent ${parent}`,
      );
    }
    seen.add(entry.id);
  }
}

test("a straight line comes back oldest first", () => {
  const all = [v("c", "b"), v("b", "a"), v("a")];
  const order = versionsInOrder(["c"], all);
  assert.deepEqual(order.map((entry) => entry.id), ["a", "b", "c"]);
});

test("a merge is emitted after both of its parents", () => {
  //      a
  //     / \
  //    b   c
  //     \ /
  //      d
  const all = [v("d", "b", "c"), v("c", "a"), v("b", "a"), v("a")];
  const order = versionsInOrder(["d"], all);
  assertParentsFirst(order);
  assert.equal(order.length, 4);
  assert.equal(order[0]!.id, "a");
  assert.equal(order[3]!.id, "d");
});

test("a diamond emits the join once, not once per path to it", () => {
  const all = [v("d", "b", "c"), v("c", "a"), v("b", "a"), v("a")];
  const order = versionsInOrder(["d"], all);
  assert.equal(new Set(order.map((entry) => entry.id)).size, order.length);
});

test("two heads sharing history emit the shared part once", () => {
  //   a - b - c   (head one)
  //        \
  //         d     (head two)
  const all = [v("d", "b"), v("c", "b"), v("b", "a"), v("a")];
  const order = versionsInOrder(["c", "d"], all);
  assertParentsFirst(order);
  assert.equal(order.length, 4);
  assert.equal(new Set(order.map((entry) => entry.id)).size, 4);
});

test("only what the requested heads can reach is included", () => {
  // `x` belongs to a line nobody asked for and must not be imported.
  const all = [v("b", "a"), v("a"), v("x", "a")];
  const order = versionsInOrder(["b"], all);
  assert.deepEqual(order.map((entry) => entry.id), ["a", "b"]);
});

test("a parent the project no longer lists does not stall the walk", () => {
  // Defensive: a version naming a parent that is not in the listing should
  // still be emitted rather than silently dropping the whole branch.
  const all = [v("b", "missing"), v("a")];
  const order = versionsInOrder(["b"], all);
  assert.deepEqual(order.map((entry) => entry.id), ["b"]);
});

test("a long line does not overflow the stack", () => {
  // The walk is iterative on purpose; a real project reaches thousands deep.
  const all: V[] = [v("v0")];
  for (let index = 1; index < 5000; index += 1) {
    all.push(v(`v${index}`, `v${index - 1}`));
  }
  const order = versionsInOrder(["v4999"], all);
  assert.equal(order.length, 5000);
  assert.equal(order[0]!.id, "v0");
  assert.equal(order[4999]!.id, "v4999");
});

test("the last commit marker wins, so a round trip does not read a stale one", () => {
  // Clone a project and push it back: the message carries the marker it was
  // imported with, plus the one this publish adds. Taking the first would name
  // a commit from the original repository.
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const twice = messageWithCommit(messageWithCommit("Work", first), second);
  assert.equal(commitFromMessage(twice), second);
  assert.equal(commitFromMessage("no marker here"), null);
});

test("rebuilding a commit message strips our bookkeeping", () => {
  const sha = "c".repeat(40);
  const stamped = messageWithCommit("Fix the export dialog\n\nWith detail.", sha);
  assert.equal(
    messageWithoutMarker(stamped),
    "Fix the export dialog\n\nWith detail.",
  );
  // A message that never had one is returned unchanged apart from trimming.
  assert.equal(messageWithoutMarker("Plain message"), "Plain message");
});

test("remote URLs are accepted in every form the docs show", () => {
  assert.equal(parseRemoteUrl("coderook://my-project").slug, "my-project");
  assert.equal(parseRemoteUrl("coderook://owner/my-project").slug, "my-project");
  assert.equal(parseRemoteUrl("coderook::my-project").slug, "my-project");
  assert.equal(parseRemoteUrl("coderook://my-project/").slug, "my-project");
  assert.throws(() => parseRemoteUrl("coderook://"));
});

test("paths are quoted only when they have to be", () => {
  // Quoting an ordinary path would make fast-import take the quotes literally.
  assert.equal(quotePath("src/a.txt"), "src/a.txt");
  assert.equal(quotePath("docs/a file with spaces.md"), "docs/a file with spaces.md");
  // Windows separators become git's, or the path names a different file.
  assert.equal(quotePath("src\\win\\a.txt"), "src/win/a.txt");
  assert.equal(quotePath('say "hi".txt'), '"say \\"hi\\".txt"');
});

test("tags and branches are told apart, so one is not published as the other", () => {
  assert.equal(tagOf("refs/tags/v1.0"), "v1.0");
  assert.equal(tagOf("refs/tags/release/2026-09"), "release/2026-09");
  assert.equal(tagOf("refs/heads/main"), null);
  assert.equal(tagOf("refs/notes/commits"), null);
});

test("a long commit message is shortened so the marker survives", () => {
  // The service refuses a version message past 240 characters, and the marker
  // is what ties a version to its commit — so the message gives way, not it.
  const sha = "d".repeat(40);
  const long = "Refactor the packing pipeline. ".repeat(20);
  const built = messageWithCommit(long, sha);
  assert.ok(built.length <= MESSAGE_LIMIT, `length ${built.length}`);
  assert.equal(commitFromMessage(built), sha);
  assert.ok(built.includes("…"), "the reader is told it was shortened");
  assert.ok(built.startsWith("Refactor the packing pipeline."));
});

test("a message that already fits is left exactly as written", () => {
  const sha = "e".repeat(40);
  const built = messageWithCommit("Fix the export dialog", sha);
  assert.ok(built.startsWith("Fix the export dialog\n\n"));
  assert.ok(!built.includes("…"));
  assert.equal(commitFromMessage(built), sha);
});

test("a message of only whitespace still produces something valid", () => {
  // The service requires at least one character, so an empty result would be
  // refused for a second, more confusing reason.
  const sha = "f".repeat(40);
  const built = messageWithCommit("   \n\n  ", sha);
  assert.ok(built.trim().length > 0);
  assert.ok(built.length <= MESSAGE_LIMIT);
  assert.equal(commitFromMessage(built), sha);
});

test("the boundary is respected exactly, not approximately", () => {
  const sha = "a".repeat(40);
  for (const size of [150, 176, 177, 178, 200, 500, 5000]) {
    const built = messageWithCommit("x".repeat(size), sha);
    assert.ok(
      built.length <= MESSAGE_LIMIT,
      `a ${size}-character message produced ${built.length}`,
    );
    assert.equal(commitFromMessage(built), sha, `marker lost at ${size}`);
  }
});

/*
  Placing the refs a fetch was asked for.

  A clone of a project with two lines used to fail outright — git aborted
  with `could not read ref refs/coderook/spike` — because commits are written
  per version while refs are per line, and the two do not correspond.
*/
test("two lines sharing one head both get a ref", () => {
  const marks = new Map([["v1", 7]]);
  const { placed, unplaceable } = refPlacements(
    [
      ["refs/heads/main", "v1"],
      ["refs/heads/spike", "v1"],
    ],
    marks,
  );
  assert.deepEqual(placed, [
    { ref: "refs/heads/main", mark: 7 },
    { ref: "refs/heads/spike", mark: 7 },
  ]);
  assert.deepEqual(unplaceable, []);
});

test("a line whose version arrived in an earlier fetch still gets a ref", () => {
  /* No commit is emitted for v1 this time; its mark comes from the marks file. */
  const { placed, unplaceable } = refPlacements(
    [["refs/heads/main", "v1"]],
    new Map([["v1", 3]]),
  );
  assert.deepEqual(placed, [{ ref: "refs/heads/main", mark: 3 }]);
  assert.deepEqual(unplaceable, []);
});

test("every line gets its own head, not the first one going", () => {
  const { placed } = refPlacements(
    [
      ["refs/heads/main", "v2"],
      ["refs/heads/spike", "v5"],
    ],
    new Map([
      ["v2", 2],
      ["v5", 5],
    ]),
  );
  assert.deepEqual(placed, [
    { ref: "refs/heads/main", mark: 2 },
    { ref: "refs/heads/spike", mark: 5 },
  ]);
});

test("a head with no commit is reported rather than guessed at", () => {
  const { placed, unplaceable } = refPlacements(
    [
      ["refs/heads/main", "v1"],
      ["refs/heads/orphan", "missing"],
    ],
    new Map([["v1", 1]]),
  );
  assert.deepEqual(placed, [{ ref: "refs/heads/main", mark: 1 }]);
  assert.deepEqual(unplaceable, ["refs/heads/orphan"]);
});

/*
  The owner in a remote URL.

  It used to be discarded, so `coderook://somebody/their-project` was read as
  "their-project on my account", found nothing, and git reported an empty
  repository — for the exact command printed on every public project page.
*/
test("a remote URL carries the owner as well as the project", () => {
  assert.deepEqual(parseRemoteUrl("coderook://demo-8/openbook"), {
    owner: "demo-8",
    slug: "openbook",
  });
});

test("a URL with no owner still names the project", () => {
  assert.deepEqual(parseRemoteUrl("coderook://openbook"), {
    owner: "",
    slug: "openbook",
  });
});

test("the other spellings of the scheme carry it too", () => {
  for (const url of [
    "coderook::demo-8/openbook",
    "coderook:demo-8/openbook",
    "coderook:///demo-8/openbook/",
  ]) {
    assert.deepEqual(parseRemoteUrl(url), { owner: "demo-8", slug: "openbook" }, url);
  }
});

test("a URL naming nothing is refused rather than guessed at", () => {
  assert.throws(() => parseRemoteUrl("coderook://"));
});

/*
  `git clone --depth N`. Git passes the number to the helper, which used to
  answer "unsupported" and import every version anyway.
*/
const line = [v("v1"), v("v2", "v1"), v("v3", "v2"), v("v4", "v3")];

test("depth 1 is the head alone", () => {
  assert.deepEqual([...withinDepth(["v4"], line, 1)], ["v4"]);
});

test("depth counts generations back from the head", () => {
  assert.deepEqual([...withinDepth(["v4"], line, 3)].sort(), ["v2", "v3", "v4"]);
});

test("a depth past the start is simply everything", () => {
  assert.equal(withinDepth(["v4"], line, 99).size, 4);
});

test("a merge counts both parents as one generation", () => {
  const merged = [v("a"), v("b", "a"), v("c", "a"), v("m", "b", "c")];
  assert.deepEqual([...withinDepth(["m"], merged, 2)].sort(), ["b", "c", "m"]);
});

test("two lines are each cut at their own depth", () => {
  const two = [v("a"), v("b", "a"), v("x", "a"), v("y", "x")];
  assert.deepEqual([...withinDepth(["b", "y"], two, 1)].sort(), ["b", "y"]);
});

test("a full clone left nothing out", () => {
  assert.equal(historyLeftOut(line, ["v1", "v2", "v3", "v4"]).size, 0);
});

test("a shallow clone's missing history stays missing on the next fetch", () => {
  /*
    Without this the first ordinary fetch after `--depth 1` imported the
    whole history anyway, as a second line of commits unconnected to the one
    the clone made.
  */
  const later = [...line, v("v5", "v4")];
  const left = historyLeftOut(later, ["v4"]);
  assert.deepEqual([...left].sort(), ["v1", "v2", "v3"]);
  assert.ok(!left.has("v5"), "what is newer still arrives");
});
