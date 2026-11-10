/**
 * Remembered rule answers must be the answers.
 *
 * `lastMatchingRule` keeps each rule's verdict on a single name so a walk of a
 * large checkout runs its regular expressions once per distinct name rather
 * than once per path (an engine checkout of 14,108 files went from about 12 s
 * to under 3 s). That is only allowed if it never answers differently from
 * asking `ruleMatches` about every rule in turn, which is what this checks —
 * across directory-only, anchored, slashed, character-class, `**` and negated
 * rules, for files and folders at several depths, asked repeatedly so the
 * remembered path is exercised as well as the first one.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  excludes,
  lastMatchingRule,
  parseRules,
  ruleMatches,
} from "../dist/core/rules.js";
import type { FolderAnswers, Rule, RuleLayer } from "../dist/core/rules.js";

const RULES = parseRules(
  [
    "*.pfx",
    "build/",
    "/custom.py",
    "docs/*.md",
    "!docs/keep.md",
    "[Ll]ibrary/",
    "**/cache/tmp",
    "*.o",
    "!important.o",
    "bin",
    "/out/",
    "thirdparty/**/test?.c",
    "node_modules",
    "*~",
  ].join("\n"),
);

const PATHS = [
  "a.pfx",
  "core/x.pfx",
  "x.pfx/inner.txt",
  "build",
  "src/build",
  "src/build/file.c",
  "custom.py",
  "src/custom.py",
  "docs/readme.md",
  "docs/keep.md",
  "docs/deep/readme.md",
  "Library",
  "library/Artifacts/a.dat",
  "src/cache/tmp",
  "cache/tmp",
  "main.o",
  "important.o",
  "dir/important.o",
  "bin",
  "bin/editor.exe",
  "tools/bin/run.sh",
  "out",
  "src/out",
  "thirdparty/zlib/test1.c",
  "thirdparty/test2.c",
  "thirdparty/a/b/testx.c",
  "web/node_modules/pkg/index.js",
  "notes.txt~",
  "plain/file.txt",
];

function slowLast(path: string, isDirectory: boolean, rules: Rule[]): Rule | null {
  let found: Rule | null = null;
  for (const rule of rules) if (ruleMatches(path, isDirectory, rule)) found = rule;
  return found;
}

test("remembered name answers agree with asking every rule", () => {
  for (let round = 0; round < 3; round += 1) {
    for (const path of PATHS) {
      for (const isDirectory of [false, true]) {
        assert.equal(
          lastMatchingRule(path, isDirectory, RULES),
          slowLast(path, isDirectory, RULES),
          `${path} (${isDirectory ? "folder" : "file"}), round ${round}`,
        );
      }
    }
  }
});

test("reusing folder answers does not change what is excluded", () => {
  const layers: RuleLayer[] = [
    { base: "", rules: RULES },
    { base: "docs", rules: parseRules(["*.md", "!keep.md"].join("\n")) },
  ];
  const answers: FolderAnswers = new Map();
  for (const path of PATHS) {
    for (const isDirectory of [false, true]) {
      assert.equal(
        excludes(path, isDirectory, layers, answers),
        excludes(path, isDirectory, layers),
        `${path} (${isDirectory ? "folder" : "file"})`,
      );
    }
  }
});
