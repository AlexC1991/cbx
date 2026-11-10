/**
 * Signed, short-lived links to one project's kept npm cache, for the hosted
 * runner (services/runner-runtime package-cache.ts).
 *
 * The runner Worker could stream the cache into the run's machine itself, but
 * that path carries about 1.3 MB/s: a 215 MB cache took 164 s to lay down,
 * longer than the install it saved (run #396). So the machine downloads it
 * from the API instead, which streams it from R2 at full speed.
 *
 * The machine never holds the runner's secret. The runner signs a link with
 * it, for one cache object and ten minutes, and the API checks the signature
 * (backend runner_cache_routes.ts). A link that leaked would read one
 * project's npm download cache for a few minutes, and nothing else: the key
 * pattern admits only cache objects.
 */

/** The only objects a link may name: runner-cache/npm/v1/<project id>/<sha-256>.tar */
export const RUNNER_CACHE_KEY = /^runner-cache\/npm\/v1\/[0-9a-f-]{36}\/[0-9a-f]{64}\.tar$/;
export const RUNNER_CACHE_ROUTE = "/v1/runner-cache/";
const LINK_SECONDS = 600;

async function signature(secret: string, key: string, expires: number): Promise<string> {
  const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`runner-cache\nGET\n${key}\n${expires}`));
  return [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A link the run's machine can download the cache from, valid for ten minutes. */
export async function signRunnerCacheUrl(origin: string, secret: string, key: string, now = Date.now()): Promise<string> {
  if (!RUNNER_CACHE_KEY.test(key)) throw new Error("Not a runner cache object");
  const expires = Math.floor(now / 1000) + LINK_SECONDS;
  const path = key.slice("runner-cache/".length);
  return `${origin.replace(/\/+$/, "")}${RUNNER_CACHE_ROUTE}${path}?exp=${expires}&sig=${await signature(secret, key, expires)}`;
}

/** The cache object a link names, or null when the link is malformed, expired or not signed with this secret. */
export async function verifyRunnerCacheUrl(secret: string, path: string, exp: string | null | undefined, sig: string | null | undefined, now = Date.now()): Promise<string | null> {
  if (!secret || !path.startsWith(RUNNER_CACHE_ROUTE) || !exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const key = `runner-cache/${path.slice(RUNNER_CACHE_ROUTE.length)}`;
  const expires = Number(exp);
  if (!RUNNER_CACHE_KEY.test(key) || expires * 1000 < now || expires * 1000 > now + LINK_SECONDS * 1000 + 60_000) return null;
  const expected = new TextEncoder().encode(await signature(secret, key, expires));
  const given = new TextEncoder().encode(sig);
  if (expected.byteLength !== given.byteLength) return null;
  /* Constant time, as the runner secret's own check is. */
  let differ = 0;
  for (let i = 0; i < expected.byteLength; i++) differ |= expected[i]! ^ given[i]!;
  return differ === 0 ? key : null;
}
