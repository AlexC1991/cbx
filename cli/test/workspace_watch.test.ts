import assert from "node:assert/strict";
import test from "node:test";

import { authorLabel, freshEvents, freshSaves, mentions } from "../dist/cli/src/workspace_watch.js";

const draft = { id: "d1", name: "Homepage hero", projectId: "p1", project: "codebox", unread: 2 };
const message = (id: string, body: string, at: string, author = { label: "UX Bot", kind: "named" as const, mine: false }) => ({
  id, kind: "message" as const, body, author, createdAt: at,
});

test("a mention is @name as a whole word, for any of the names a reader answers to", () => {
  assert.equal(mentions("@Claude can you check the footer?", "Claude"), true);
  assert.equal(mentions("thanks @claude.", ["Claude"]), true);
  assert.equal(mentions("@UX Bot please look", ["UX Bot"]), true);
  assert.equal(mentions("@Claude-helper ran it", "Claude"), false);
  assert.equal(mentions("email me at sam@Claude.com", "Claude"), false);
  assert.equal(mentions("@sam the build is green", ["sam", "Sam Rivers"]), true);
  assert.equal(mentions("nothing for anyone", ["sam", "Sam Rivers"]), false);
  assert.equal(mentions("@sam", []), false);
});

test("watch reports each new message once, marks the ones addressed to the reader, and skips its own and the past", () => {
  const state = { seen: new Set(), newest: new Map(), since: Date.parse("2026-11-06T10:00:00Z") };
  const first = freshEvents(state, draft, [
    message("m0", "old news", "2026-11-06T09:00:00Z"),
    message("m2", "@Claude please review", "2026-11-06T10:02:00Z"),
    message("m1", "build is green", "2026-11-06T10:01:00Z"),
    message("m3", "my own note", "2026-11-06T10:03:00Z", { label: "Claude", kind: "named", mine: true }),
  ], "Claude");
  assert.deepEqual(first.map((e) => [e.type, "id" in e ? e.id : null]), [["message", "m1"], ["mention", "m2"]]);
  const again = freshEvents(state, draft, [message("m2", "@Claude please review", "2026-11-06T10:02:00Z")], "Claude");
  assert.deepEqual(again, []);
});

test("saves: the first look records where things stand, later looks report only newer versions in order", () => {
  const state = { seen: new Set(), newest: new Map(), since: 0 };
  assert.deepEqual(freshSaves(state, { id: "p1", name: "codebox" }, [{ sequence: 300 }, { sequence: 299 }]), []);
  const next = freshSaves(state, { id: "p1", name: "codebox" }, [{ sequence: 302, message: "b" }, { sequence: 301, message: "a" }, { sequence: 300 }]);
  assert.deepEqual(next.map((e) => (e.type === "save" ? e.sequence : 0)), [301, 302]);
});

test("the author line says how sure the service is about who wrote it", () => {
  assert.equal(authorLabel({ label: "You", kind: "person", mine: false }), "You (site)");
  assert.equal(authorLabel({ label: "Laptop", kind: "token", mine: false }), "Laptop (own token)");
  assert.equal(authorLabel({ label: "UX Bot", kind: "named", mine: false }), "UX Bot (named, not verified)");
});
