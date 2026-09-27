/**
 * What this build calls itself to the service.
 *
 * Read from the package rather than written down, because a hardcoded copy had
 * already drifted from the published version once — and the version is not
 * cosmetic. The service refuses operations it knows an older client cannot do
 * safely, so a build that misstates its version is refused as though it were
 * ancient.
 *
 * Which is exactly what happened: the git remote helper announced itself as
 * `cli/git-remote`, having passed its own name where the version belongs. The
 * service could make nothing of it, applied the floor, and told people to
 * update to a version far older than the one they were running. Pushing was
 * unaffected and cloning was refused, so it surfaced only on the way back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Search upwards for this package's own manifest.
 *
 * A fixed number of `..` segments only holds for one directory layout. The
 * compiled file sits three deep under `dist`, the source two deep under `src`,
 * and a bundler may put it somewhere else again — so a fixed path silently
 * resolved to a different package's manifest, or to none, and fell back to
 * `0.0.0`. Walking up and checking the name finds the right file wherever
 * this ends up.
 */
function readVersion(): string {
  /*
    `__dirname` in the build, which compiles to CommonJS and is what ships.
    Running the source directly for a test loads it as a module where that name
    does not exist, so the check is on `typeof` — which is safe for a name that
    was never declared — and the working directory stands in.
  */
  let here: string =
    typeof __dirname === "string" ? __dirname : process.cwd();
  for (let up = 0; up < 6; up += 1) {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(here, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      if (manifest.name === "@coderook/cli" && manifest.version) {
        return manifest.version;
      }
    } catch {
      // Not here, or not readable. Keep walking.
    }
    const parent = path.dirname(here);
    if (parent === here) break;
    here = parent;
  }
  return "0.0.0";
}

export const VERSION: string = readVersion();
