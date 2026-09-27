import assert from "node:assert/strict";
import test from "node:test";

import { worthRetrying } from "../dist/core/retry.js";

/**
 * Whether a failed request is tried again.
 *
 * This exists because of a specific run. Twenty-eight gigabytes, roughly
 * fourteen hundred requests, twenty-four minutes at a steady eight and a half
 * megabytes a second, fifty of eighty-seven sections finished — and then one
 * request returned `fetch failed` and the whole upload ended. Eleven gigabytes
 * of completed, verified work discarded because a single connection dropped.
 *
 * The uploader had no retries at all, and the comments explaining why that was
 * safe were all correct: objects are immutable and content-addressed, so
 * repeating a request costs nothing. Every call site could see that. None of
 * them did it.
 *
 * The danger in fixing it is retrying the wrong things. A refusal repeated
 * five times with backoff is not resilience — it is the same refusal delivered
 * fifteen seconds later, with the message that explained it buried under four
 * pointless attempts. So the split below is the whole of the fix, and each
 * case here is a failure that really occurs rather than a category invented to
 * fill out a table.
 */

/** A failure carrying a status, as `call` throws it. */
const refusal = (status: number, code = "") =>
  Object.assign(new Error(`failed (${status})`), { status, code });

test("a dropped connection is retried", () => {
  /*
    The one that ended the run. `fetch` rejects with a TypeError carrying no
    status at all, because the request never reached anything that could form
    an opinion about it.
  */
  assert.equal(worthRetrying(new TypeError("fetch failed")), true);
});

test("anything without a status is retried", () => {
  /* Reset sockets, DNS failures, a malformed reply from an edge page. */
  for (const error of [
    new Error("ECONNRESET"),
    new Error("getaddrinfo ENOTFOUND"),
    new Error("/v1/repositories returned a malformed reply"),
  ]) {
    assert.equal(worthRetrying(error), true, error.message);
  }
});

test("a request that outran its deadline is retried", () => {
  /*
    The case this rule always named and could never see.

    Nothing in either client set a deadline, so no request could time out and
    this branch was unreachable. A real save of a 38,913-file project proved
    the cost: one open connection, no bytes moving in either direction, no
    CPU, and no message — it simply never finished. The deadline turns that
    into an ordinary error, and this is the assertion that it is treated as
    one worth repeating rather than as a verdict.
  */
  const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(worthRetrying(timedOut), true);

  /* And the shape `fetch` actually rejects with, which carries no status. */
  assert.equal(worthRetrying(Object.assign(new Error("The operation timed out"), {})), true);
});

test("the service's own refusals are not retried", () => {
  /*
    Every 4xx the service returns names a settled condition. Retrying them
    turns a clear answer into a delayed identical answer, and buries the
    message the person actually needs to read.
  */
  for (const [status, code] of [
    [400, "batch_malformed"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "repository_not_found"],
    [409, "upload_not_active"],
  ] as const) {
    assert.equal(worthRetrying(refusal(status, code)), false, `${status} ${code}`);
  }
});

test("a full upload window is not retried", () => {
  /*
    The exception that matters most, and the reason 429 cannot simply be
    treated as transient. A staged monthly allowance refusal can stand until
    the next seven-day unlock boundary, so retrying would hang the upload
    behind four backoffs and then report the same thing — while the message it
    carries names the next unlock time, which is the only useful part.
  */
  assert.equal(
    worthRetrying(refusal(429, "upload_rate_exceeded")),
    false,
  );
});

test("edge throttling is retried", () => {
  /*
    The same status, the opposite meaning. A 429 without the service's code on
    it came from in front of the service and clears in seconds.
  */
  assert.equal(worthRetrying(refusal(429)), true);
});

test("a service that is briefly unwell is retried", () => {
  for (const status of [500, 502, 503, 504, 408]) {
    assert.equal(worthRetrying(refusal(status)), true, String(status));
  }
});

test("cancellation is the caller's to recognise, not this rule's", () => {
  /*
    Upload and download each have their own cancelled-error type, and this
    predicate is shared by both. Teaching it about one would couple the two
    for a single `instanceof`, so each caller checks for its own before asking
    — and a cancellation reaching here at all would be a caller that forgot.

    Recorded as a property rather than a gap: it looks like an untested case
    and it is a deliberate boundary.
  */
  const cancelled = new Error("Upload cancelled");
  assert.equal(
    worthRetrying(cancelled),
    true,
    "carries no status, so this rule alone cannot tell it from a dropped socket",
  );
});

test("the split is exhaustive over statuses", () => {
  /*
    A property rather than a list, so a status nobody thought about still gets
    a defined answer: below 500, only 408 and a throttling 429 are repeated;
    at 500 and above, everything is.
  */
  for (let status = 400; status < 600; status += 1) {
    const expected =
      status >= 500 || status === 408 || status === 429;
    assert.equal(
      worthRetrying(refusal(status)),
      expected,
      `status ${status}`,
    );
  }
});
