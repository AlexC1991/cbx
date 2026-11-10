/**
 * Reaching the service on networks that half-support IPv6.
 *
 * Found from Linux: a router hands out IPv6 addresses but has no IPv6 route.
 * Node tries both families at once and gives each address 250 ms. The IPv6
 * attempt fails at once, and an IPv4 handshake that occasionally takes longer
 * than 250 ms is abandoned too, so a perfectly healthy connection came back as
 * the two words "fetch failed". curl and browsers never showed it.
 */
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
    /*
      Applied just before the first request rather than at start. Loading
      node:dns sets up its resolver, about twenty milliseconds, which commands
      that never touch the network (a local status, a local save) were paying
      on every run. Every request here goes through fetch.
    */
    const original = globalThis.fetch;
    let tuned = false;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      if (!tuned) {
        tuned = true;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          (require("node:dns") as typeof import("node:dns")).setDefaultResultOrder("ipv4first");
        } catch {
          /* Older Node: nothing to tune. */
        }
      }
      return original(...args);
    }) as typeof fetch;
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
  const cause = (error as { cause?: Cause & { message?: string } }).cause;
  if (error.message === "terminated") {
    /*
      undici's word for an answer whose body stopped arriving: the server
      hung up mid-reply, or something between here and it did. On its own it
      read as though the command had been killed.
    */
    const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
    return (
      "The connection to CodeRook closed before its answer finished arriving" +
      (detail ? ` (${detail})` : "") +
      ". Check the connection, then try again."
    );
  }
  if (error.message === "fetch failed") {
    /*
      Said in words first, with the code after for whoever needs it. The most
      common one, ENOTFOUND, is simply being offline: the name could not be
      looked up. And a failure that carries no code at all used to fall
      through to the bare "fetch failed" it exists to replace.
    */
    const attempts = cause?.errors?.length ? cause.errors : cause ? [cause] : [];
    const codes = [...new Set(attempts.map((one) => one.code).filter(Boolean))] as string[];
    const said = codes.map((code) => PLAIN[code]).find(Boolean);
    const named = attempts
      .map((one) => [one.code, one.address].filter(Boolean).join(" "))
      .filter(Boolean);
    const detail = named.length ? [...new Set(named)].join(", ") : cause?.message ?? "";
    return (
      `Could not reach CodeRook${said ? `: ${said}` : ""}` +
      (detail ? ` (${detail})` : "") +
      ". Check the connection, then try again."
    );
  }
  return error.message;
}

/** What each network failure means, for somebody who has not met the code. */
const PLAIN: Record<string, string> = {
  ENOTFOUND: "its address could not be looked up, which usually means this computer is offline",
  EAI_AGAIN: "its address could not be looked up, which usually means this computer is offline",
  ECONNREFUSED: "the connection was refused",
  ECONNRESET: "the connection was dropped",
  ETIMEDOUT: "the connection timed out",
  ENETUNREACH: "there is no route to the internet from here",
  EHOSTUNREACH: "there is no route to the internet from here",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
};

/** Wait, for a retry. */
export function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
