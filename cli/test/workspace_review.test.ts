import assert from "node:assert/strict";
import test from "node:test";

import { describeReviewer } from "../dist/cli/src/workspace_review.js";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
const base = { reviewer: "token:x", label: "UX Bot", applies: true, revision: 4, note: "", beforeSave: true, beforeDeploy: false } as const;

test("each reviewer line says where it stands in words, not only colour", () => {
  assert.equal(plain(describeReviewer({ ...base, state: "ok", note: "Matches" }, 4)), "OK UX Bot before save Matches");
  assert.equal(plain(describeReviewer({ ...base, state: "waiting", revision: null }, 4)), "waiting UX Bot before save");
  assert.equal(plain(describeReviewer({ ...base, state: "outdated", revision: 3 }, 4)), "outdated UX Bot before save OK was for revision 3, draft is at 4");
  assert.equal(plain(describeReviewer({ ...base, state: "changes", note: "Fix the gold", beforeDeploy: true }, 4)), "changes UX Bot before save + deploy Fix the gold");
  assert.equal(plain(describeReviewer({ ...base, applies: false, state: "waiting" }, 4)), "not needed UX Bot (no changes in its paths)");
});
