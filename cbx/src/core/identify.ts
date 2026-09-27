/**
 * How a client says what it is.
 *
 * The service refuses certain operations to builds known to perform them
 * unsafely, which is the only lever that reaches a copy already installed on
 * somebody's machine. That lever needs the client to be identifiable, and the
 * user agent could not do it: every build so far has sent the same hardcoded
 * string, so there was nothing to tell them apart by.
 *
 * One header, sent on every request, in a shape that parses.
 */
export type ClientKind = "cli" | "desktop";

/** Set once at start-up, because the two clients learn their version differently. */
let identity = "";

export function declareClient(kind: ClientKind, version: string): void {
  identity = `${kind}/${version}`;
}

/**
 * The identifying headers, or nothing when start-up has not declared yet.
 *
 * Returning nothing rather than a guess matters: an unrecognised client is
 * allowed through, so a wrong guess would be worse than silence — it would
 * claim a version whose behaviour this build does not have.
 */
export function clientHeaders(): Record<string, string> {
  return identity ? { "x-coderook-client": identity } : {};
}

/**
 * What the service said when it refused a build.
 *
 * Recognised by its own code rather than the status, so the message can say
 * what to do instead of leaving somebody with a number.
 */
export type TooOld = {
  capability: string;
  minimumSupported: string;
  yourVersion: string | null;
  upgradeUrl: string;
  message: string;
};

export function readRefusal(status: number, body: string): TooOld | null {
  if (status !== 426) return null;
  try {
    const parsed = JSON.parse(body) as { error?: Record<string, unknown> };
    const error = parsed.error;
    if (!error || error.code !== "client_too_old") return null;
    return {
      capability: String(error.capability ?? "that"),
      minimumSupported: String(error.minimumSupported ?? "a newer version"),
      yourVersion: error.yourVersion ? String(error.yourVersion) : null,
      upgradeUrl: String(error.upgradeUrl ?? "https://coderook.com/download"),
      message: String(error.message ?? "This version is too old."),
    };
  } catch {
    return null;
  }
}
