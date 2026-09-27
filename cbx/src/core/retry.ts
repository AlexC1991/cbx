/**
 * Trying again, and knowing when not to.
 *
 * Both directions need this and neither had it. The uploader's absence of
 * retries ended a twenty-eight gigabyte run at section fifty-one of
 * eighty-seven, twenty-four minutes in, because one request came back `fetch
 * failed`. The downloader has the same shape of problem and a worse
 * consequence: a restore that gives up part way through has already written
 * nothing usable, and the person is left without the thing they were
 * restoring.
 *
 * It lives apart from both because the rule is the same for both and the
 * cancellation is not. Each side has its own cancelled-error type, so each
 * side checks for its own before asking this whether the failure was worth
 * repeating. That keeps this module ignorant of either, rather than importing
 * one into the other and coupling upload to download for a single `instanceof`.
 */

/**
 * How many times one request is attempted before giving up.
 *
 * Five attempts with doubling backoff covers an outage of roughly fifteen
 * seconds, which is far longer than the reconnects that actually end long
 * transfers. Longer than that and a genuine outage is being waited on rather
 * than reported, which helps nobody.
 */
export const RETRY_ATTEMPTS = 5;

/** The first backoff. Doubles each attempt, and is jittered when used. */
export const RETRY_FIRST_WAIT_MS = 500;

/**
 * Whether a failure is worth trying again.
 *
 * The service's refusals are deliberate and none of them change on a second
 * attempt: every 4xx it returns names a settled condition — the version is
 * gone, the body is malformed, the quota is full — that a retry would meet
 * again identically. Repeating those turns a clear answer into a long pause
 * followed by the same answer, with the message that explained it buried under
 * four pointless attempts.
 *
 * What is worth repeating is everything that never reached a verdict: a
 * dropped connection, a gateway mid-restart, a request that timed out. Those
 * carry no decision at all, and they are the whole failure population that
 * ends long transfers.
 *
 * Cancellation is not considered here. It is a decision too — the user's —
 * and each caller recognises its own before asking.
 */
export function worthRetrying(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (typeof status !== "number") {
    /*
      No status means the request never got an answer — `fetch failed`, a
      reset socket, a name that did not resolve. This is the case that ended
      the twenty-eight gigabyte upload.
    */
    return true;
  }
  if (status === 429) {
    /*
      The one 4xx worth repeating, and only sometimes. A 429 from the edge is
      throttling and clears in seconds. A 429 from the upload window is a
      refusal that stands for days, so retrying it would hang the transfer
      instead of showing the person the message that explains it.
    */
    return (error as { code?: string }).code !== "upload_rate_exceeded";
  }
  if (status === 408) return true;
  return status >= 500;
}

/**
 * Wait, unless the signal aborts while waiting.
 *
 * Jittered, because the lanes fail together. Six requests against a gateway
 * that has just gone away all fail within milliseconds of each other, and six
 * retries timed from those failures would arrive together too — which turns
 * one outage into a second one at precisely the wrong moment.
 */
export function pauseFor(signal: AbortSignal, ms: number): Promise<void> {
  const delay = ms * (0.5 + Math.random());
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, delay);
    signal.addEventListener("abort", stop, { once: true });
  });
}
