/**
 * Reading a folder's link the way the command line now stores it.
 *
 * The live tests used to open `links.json` and index into it. That file was
 * one record for every folder the machine had ever linked, read and rewritten
 * whole by every command; it is now one small file per folder under `links/`.
 *
 * The old file is still read when it is there, because the upgrade test makes
 * its workspaces with an older client, which writes exactly that.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { keyFor } from "../dist/cli/src/config.js";

/** The file one folder's link lives in, inside a given config folder. */
export function linkFile(home, folder) {
  const name = createHash("sha256").update(keyFor(folder)).digest("hex").slice(0, 32);
  return path.join(home, "links", `${name}.json`);
}

function unpack(stored) {
  if (!stored || stored.forgotten) return null;
  const { localIsManifest, ...link } = stored.link;
  return localIsManifest ? { ...link, local: { ...link.manifest } } : link;
}

/** One folder's link, from whichever store holds it. */
export function linkIn(home, folder) {
  const file = linkFile(home, folder);
  if (existsSync(file)) return unpack(JSON.parse(readFileSync(file, "utf8")));
  const legacy = path.join(home, "links.json");
  if (!existsSync(legacy)) return null;
  const links = JSON.parse(readFileSync(legacy, "utf8"));
  return links[keyFor(folder)] ?? links[path.resolve(folder).toLowerCase()] ?? null;
}

/** The link in a config folder that only ever linked one folder. */
export function firstLink(home) {
  const legacy = path.join(home, "links.json");
  if (existsSync(legacy)) {
    const links = JSON.parse(readFileSync(legacy, "utf8"));
    return links[Object.keys(links)[0]];
  }
  const directory = path.join(home, "links");
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const link = unpack(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
    if (link) return link;
  }
  return null;
}
