/**
 * Reaching the service on networks that half-support IPv6.
 *
 * Found from Linux: a router hands out IPv6 addresses but has no IPv6 route.
 * Node tries both families at once and gives each address 250 ms. The IPv6
 * attempt fails at once, and an IPv4 handshake that occasionally takes longer
 * than 250 ms is abandoned too, so a perfectly healthy connection came back as
 * the two words "fetch failed". curl and browsers never showed it.
 */
import dns from "node:dns";
import net from "node:net";

/** Called once, before any request. Explicit settings in NODE_OPTIONS win. */
export function tuneNetwork(): void {
  const options = process.env.NODE_OPTIONS ?? "";
  if (!options.includes("autoselection-attempt-timeout")) {
    try {
      net.setDefaultAutoSelectFamilyAttemptTimeout(1_000);
    } catch {
      /* Older Node: nothing to tune. */
    }
  }
  if (!options.includes("dns-result-order")) {
    try {
      dns.setDefaultResultOrder("ipv4first");
    } catch {
      /* Older Node: nothing to tune. */
    }
  }
}

type Cause = { code?: string; address?: string; errors?: Cause[] };

/** Whether a failure happened before any answer came back. */
export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  return error.message === "fetch failed" || Boolean((error as { cause?: unknown }).cause);
}

/**
 * The real reason, instead of "fetch failed".
 *
 * Node puts what went wrong in `cause` (and, for a failed happy-eyeballs
 * connection, in `cause.errors`, one per address tried). Naming the code and
 * the address is what lets somebody tell a dead network from a slow one.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") {
    return "CodeRook did not answer in time. Check the connection, then try again.";
  }
  const cause = (error as { cause?: Cause }).cause;
  if (error.message === "fetch failed" && cause) {
    const attempts = cause.errors?.length ? cause.errors : [cause];
    const named = attempts
      .map((one) => [one.code, one.address].filter(Boolean).join(" "))
      .filter(Boolean);
    if (named.length) {
      return `Could not reach CodeRook (${[...new Set(named)].join(", ")}). Check the connection, then try again.`;
    }
  }
  return error.message;
}

/** Wait, for a retry. */
export function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
