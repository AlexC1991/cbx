import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `cbx --help`, the command list: every command once, in a group that is
 * listed, on a line that fits a 100-column terminal.
 *
 * The table is read from the built file, which only runs a command when it is
 * started as the program — so loading it here runs nothing.
 */

const require = createRequire(import.meta.url);
type Spec = { name: string; group: string; usage: string; brief?: string; summary: string; aliases?: string[]; deprecatedBy?: string };
const { REGISTRY } = require(path.resolve("dist/cli/src/cli.js")) as {
  REGISTRY: { specs: Spec[]; lookup: Map<string, Spec> };
};
const { GROUP_ORDER, LISTING_ORDER } = require(path.resolve("dist/cli/src/registry.js")) as {
  GROUP_ORDER: string[];
  LISTING_ORDER: string[];
};

const home = mkdtempSync(path.join(tmpdir(), "coderook-help-"));
const help = execFileSync(process.execPath, ["dist/cli/src/cli.js", "--help"], {
  encoding: "utf8",
  env: { ...process.env, CODEROOK_TOKEN: "", CODEROOK_CONFIG_DIR: home, NO_COLOR: "1" },
});
const listed = REGISTRY.specs.filter((spec) => !spec.deprecatedBy);
const rows = help.split(/\r?\n/).filter((line) => line.startsWith("  "));

test("every command appears exactly once in the listing", () => {
  for (const spec of listed) {
    const usage = spec.brief ?? spec.usage;
    const matching = rows.filter((row) => row.trimStart().split(/\s+/)[0] === spec.name);
    assert.equal(matching.length, 1, `${spec.name} is listed ${matching.length} times`);
    assert.ok(matching[0]!.includes(usage), `${spec.name} shows "${usage}"`);
  }
  assert.equal(rows.length, listed.length, "a listed row that is not a command");
});

test("each command is in a listed group and in the listing order", () => {
  for (const spec of listed) {
    assert.ok(GROUP_ORDER.includes(spec.group), `${spec.name}: unknown group ${spec.group}`);
    assert.ok(LISTING_ORDER.includes(spec.name), `${spec.name} is missing from LISTING_ORDER`);
  }
  const names = new Set(listed.map((spec) => spec.name));
  for (const name of LISTING_ORDER) assert.ok(names.has(name), `LISTING_ORDER names ${name}, which is not a command`);
  assert.equal(new Set(LISTING_ORDER).size, LISTING_ORDER.length, "LISTING_ORDER repeats a name");
});

test("no line of the listing is wider than 100 columns", () => {
  for (const line of help.split(/\r?\n/)) assert.ok(line.length <= 100, `${line.length}: ${line}`);
});

test("aliases still reach their command", () => {
  for (const spec of REGISTRY.specs) {
    for (const alias of spec.aliases ?? []) assert.equal(REGISTRY.lookup.get(alias)?.name, spec.name, alias);
  }
  const page = execFileSync(process.execPath, ["dist/cli/src/cli.js", "help", "webhooks"], {
    encoding: "utf8",
    env: { ...process.env, CODEROOK_TOKEN: "", CODEROOK_CONFIG_DIR: home, NO_COLOR: "1" },
  });
  assert.match(page, /cbx hooks — /);
  assert.match(page, /Usage\n {2}cbx hooks \[project\]/);
});
