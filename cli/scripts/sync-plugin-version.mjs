/*
  The plugin manifest carries a version, and Claude Code uses it to decide
  whether a cached copy is still current. A stale one means installed users
  never see an update.

  A hardcoded copy had already drifted once in this package, so this is not
  a hypothetical: the number is derived from package.json at publish time
  rather than typed in two places and hoped about.
*/
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const path = new URL("../.claude-plugin/plugin.json", import.meta.url);
const plugin = JSON.parse(readFileSync(path, "utf8"));

if (plugin.version === pkg.version) {
  console.log(`plugin.json already at ${pkg.version}`);
} else {
  const was = plugin.version;
  plugin.version = pkg.version;
  writeFileSync(path, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`plugin.json ${was} -> ${pkg.version}`);
}
