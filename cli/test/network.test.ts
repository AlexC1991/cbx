import assert from "node:assert/strict";
import test from "node:test";

const { describeError } = await import("../dist/cli/src/network.js");

/**
 * What somebody sees when CodeRook cannot be reached.
 *
 * Node reports every one of these as "fetch failed", with the reason tucked
 * into `cause`. The message is the only thing a person offline has to go on,
 * so it says what happened in words, then the code for whoever needs it.
 */
const failed = (cause?: unknown) => Object.assign(new Error("fetch failed"), cause ? { cause } : {});

test("offline reads as offline, not as a code", () => {
  const text = describeError(failed({ code: "ENOTFOUND", hostname: "api.coderook.com" }));
  assert.match(text, /^Could not reach CodeRook: its address could not be looked up, which usually means this computer is offline \(ENOTFOUND\)\./);
  assert.match(text, /Check the connection, then try again\.$/);
});

test("a refused connection names the address it tried", () => {
  const text = describeError(failed({ code: "ECONNREFUSED", address: "127.0.0.1" }));
  assert.match(text, /the connection was refused \(ECONNREFUSED 127\.0\.0\.1\)/);
});

test("every address tried is named once", () => {
  const text = describeError(
    failed({ errors: [{ code: "ETIMEDOUT", address: "2606::1" }, { code: "ETIMEDOUT", address: "104.0.0.1" }] }),
  );
  assert.match(text, /the connection timed out \(ETIMEDOUT 2606::1, ETIMEDOUT 104\.0\.0\.1\)/);
});

test("a failure with no code still never says only \"fetch failed\"", () => {
  assert.equal(
    describeError(failed({ message: "bad port" })),
    "Could not reach CodeRook (bad port). Check the connection, then try again.",
  );
  assert.equal(describeError(failed()), "Could not reach CodeRook. Check the connection, then try again.");
});

test("anything that is not a network failure passes through untouched", () => {
  assert.equal(describeError(new Error("No project matching \"x\" on your account.")), "No project matching \"x\" on your account.");
});

test("a body cut mid-answer is said in words, not as \"terminated\"", () => {
  const cut = Object.assign(new TypeError("terminated"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
  const text = describeError(cut);
  assert.equal(
    text,
    "The connection to CodeRook closed before its answer finished arriving " +
      "(UND_ERR_SOCKET: other side closed). Check the connection, then try again.",
  );
});
