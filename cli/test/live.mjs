/**
 * Shared guards for the suites that talk to a real service.
 *
 * These suites are not simulations: they sign in as somebody, create real
 * projects, publish real versions and consume real storage. Two things follow
 * that a normal test file never has to think about.
 *
 * The first is that running one by accident is destructive. A suite pointed
 * at production without anybody meaning it operates on somebody's actual
 * account, so the target has to be said out loud rather than defaulted to.
 *
 * The second is that a crash leaves debris. Cleanup written at the end of a
 * script only runs when the script reaches the end — a failed assertion, a
 * thrown error or a Ctrl+C leaves every project the run created sitting on
 * the account, and the next run adds more. So cleanup is registered up front
 * and runs however the process ends.
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRODUCTION = /(^|\/\/)api\.coderook\.com/;

export const apiOrigin = () =>
  (process.env.CODEROOK_API_URL || "https://api.coderook.com").replace(/\/+$/, "");

export function liveToken() {
  if (process.env.CODEROOK_TOKEN?.trim()) return process.env.CODEROOK_TOKEN.trim();
  const home =
    process.env.CODEROOK_CONFIG_DIR ?? path.join(process.env.APPDATA ?? "", "CodeRook");
  return readFileSync(path.join(home, "token"), "utf8").trim();
}

/**
 * Where a suite should put its scratch folders.
 *
 * Taken from the first argument that is not a flag, because these are run
 * both bare and with `--allow-production`, and reading argv[2] blindly turns
 * the flag itself into a directory name.
 */
export function scratchRoot(name) {
  const given = process.argv.slice(2).find((one) => !one.startsWith("-"));
  if (given) return given;
  // Not the working directory: these runs make and abandon whole project
  // trees, and a repository is the wrong place to leave them lying about.
  return path.join(tmpdir(), `coderook-${name}-${process.pid}`);
}

/**
 * Refuse to run against production unless somebody said so.
 *
 * Deliberately not satisfied by anything ambient. An environment variable
 * that happens to be set in a shell, or a default in a script, is exactly how
 * a suite ends up deleting from an account nobody meant to touch.
 */
export function assertSafeTarget() {
  const origin = apiOrigin();
  if (!PRODUCTION.test(origin)) return origin;

  const allowed =
    process.argv.includes("--allow-production") ||
    process.env.CODEROOK_ALLOW_PRODUCTION === "yes-i-mean-production";
  if (allowed) return origin;

  console.error(
    [
      "",
      `  This suite would run against ${origin}.`,
      "",
      "  That is a real account. It creates projects, publishes versions and",
      "  consumes storage against it. Nothing here is a simulation.",
      "",
      "  If that is what you want, say so:",
      "",
      "      npm run test:live",
      "",
      "  or pass --allow-production to one suite. To run against something",
      "  else, set CODEROOK_API_URL.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

/**
 * Delete everything this run created, however the run ends.
 *
 * `mine` decides what belongs to this run and nothing else — it is given a
 * slug and must be certain. Sweeping on a loose prefix would delete somebody
 * else's project that happened to be named similarly, which is a far worse
 * failure than leaving debris behind.
 */
export function autoClean(mine, scratch) {
  const origin = apiOrigin();
  const headers = { authorization: `Bearer ${liveToken()}` };
  let done = false;

  const sweep = async (why = "") => {
    if (done) return;
    done = true;
    try {
      const response = await fetch(`${origin}/v1/repositories`, { headers });
      const { repositories = [] } = await response.json();
      const ours = repositories.filter((one) => mine(one.slug));
      if (ours.length && why) {
        console.error(`\n  ${why} — removing ${ours.length} project(s) this run made`);
      }
      for (const one of ours) {
        await fetch(`${origin}/v1/repositories/${one.id}`, { method: "DELETE", headers });
      }
    } catch (error) {
      // Say so rather than exit quietly: debris left on an account is
      // something the person needs to know about to deal with.
      console.error(`  could not clean up after this run: ${error.message}`);
    }
    // The folders on disk go the same way, and for the same reason.
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* something still has a handle on it; the temp directory will do */
      }
    }
  };

  const bail = (label) => async (error) => {
    if (error) console.error(error);
    await sweep(label);
    process.exit(label === "interrupted" ? 130 : 1);
  };
  process.on("uncaughtException", bail("failed"));
  process.on("unhandledRejection", bail("failed"));
  process.on("SIGINT", bail("interrupted"));
  process.on("SIGTERM", bail("interrupted"));

  return sweep;
}

/**
 * One file from a version listing, in the shape a version POST accepts.
 *
 * A file is stored as one whole object, as a list of chunks, or as a slice of
 * a solid pack, and the service accepts exactly one of the three. Five tests
 * each rebuilt every file as `objectId`, which is null for the other two — so
 * the moment anything was small enough to be packed, and most things are, the
 * version they were building was refused with a 400 nobody printed. The tests
 * then failed on an assertion about something else entirely: `state-matrix`
 * reported three rows that "did not run to completion", and `get-safety`
 * reported that a dropped file was not removed, when in truth no version
 * dropping it had ever been created.
 *
 * Written once here so a sixth caller inherits the answer rather than the bug.
 */
export function versionFilePayload(file) {
  return {
    path: file.path,
    ...(file.objectId ? { objectId: file.objectId } : {}),
    ...(file.pack ? { pack: file.pack } : {}),
    ...(file.chunks?.length ? { chunks: file.chunks } : {}),
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
    sourceSize: file.sourceSize,
    storedSize: file.storedSize,
    mediaType: file.mediaType || "text/plain",
  };
}
