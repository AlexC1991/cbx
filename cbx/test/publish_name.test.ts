import assert from "node:assert/strict";
import test from "node:test";

import { publishAttemptName } from "../src/core/publish_name.ts";

/**
 * The name given to one publishing attempt. It must survive a retry and it
 * must not survive anything else — those two together are the whole point.
 */
const base = {
  repositoryId: "repo-1",
  expectedHeadVersionId: "head-1",
  message: "Saving my work",
  files: [
    { path: "src/main.ts", objectId: "object-a" },
    { path: "README.md", objectId: "object-b" },
  ],
};

test("the same attempt is named the same twice", () => {
  assert.equal(publishAttemptName(base), publishAttemptName(base));
});

test("the order files arrive in does not change the name", () => {
  assert.equal(
    publishAttemptName(base),
    publishAttemptName({ ...base, files: [...base.files].reverse() }),
  );
});

test("changed content is a different attempt", () => {
  assert.notEqual(
    publishAttemptName(base),
    publishAttemptName({
      ...base,
      files: [base.files[0]!, { path: "README.md", objectId: "object-c" }],
    }),
  );
});

test("a renamed file is a different attempt", () => {
  assert.notEqual(
    publishAttemptName(base),
    publishAttemptName({
      ...base,
      files: [{ path: "moved.ts", objectId: "object-a" }, base.files[1]!],
    }),
  );
});

test("a different message is a different attempt", () => {
  assert.notEqual(
    publishAttemptName(base),
    publishAttemptName({ ...base, message: "Something else" }),
  );
});

test("publishing against a moved head is a different attempt", () => {
  // Otherwise a retry could be answered with a version built on the wrong base.
  assert.notEqual(
    publishAttemptName(base),
    publishAttemptName({ ...base, expectedHeadVersionId: "head-2" }),
  );
});

test("the same content in another project is a different attempt", () => {
  assert.notEqual(
    publishAttemptName(base),
    publishAttemptName({ ...base, repositoryId: "repo-2" }),
  );
});

test("a project that does not exist yet still gets a name", () => {
  const name = publishAttemptName({ ...base, repositoryId: null });
  assert.match(name, /^[0-9a-f]{40}$/);
});

test("dropping a file changes the name", () => {
  assert.notEqual(
    publishAttemptName(base),
    publishAttemptName({ ...base, files: [base.files[0]!] }),
  );
});
