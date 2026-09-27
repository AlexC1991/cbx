/**
 * The rules file is called .gitignore, so it has to mean what git means.
 *
 * The case that brought this on: a project excluded `work/t3code-audit/`, and
 * an unrelated `!.env.example` further down the file re-included two files
 * from inside it. git had ignored both — `git check-ignore` named the very
 * rule — so nothing in the toolchain gave any sign, and they went up with a
 * public version.
 *
 * git's rule is that a parent directory being excluded settles the question:
 * "it is not possible to re-include a file if a parent directory of that file
 * is excluded". Differing from that at all is bad, and differing in the
 * permissive direction is the dangerous half — it publishes what somebody
 * believed they had excluded.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  excludes,
  negationReachesInto,
  parseRules,
} from "../dist/core/rules.js";
import type { RuleLayer } from "../dist/core/rules.js";

const NEWLINE = String.fromCharCode(10);

const layers = (body: string): RuleLayer[] => [
  { base: "", rules: parseRules(body) },
];

test("a negation cannot reach inside an excluded directory", () => {
  const rules = layers(["work/t3code-audit/", ".env", ".env.*", "!.env.example"].join("\n"));

  assert.equal(
    excludes("work/t3code-audit/.env.example", false, rules),
    true,
    "the exact file that leaked",
  );
  assert.equal(
    excludes("work/t3code-audit/infra/relay/.env.example", false, rules),
    true,
    "and the one further down",
  );
});

test("the same negation still works outside an excluded directory", () => {
  const rules = layers(["work/t3code-audit/", ".env", ".env.*", "!.env.example"].join("\n"));

  assert.equal(
    excludes(".env.example", false, rules),
    false,
    "a negation is not broken in general, only stopped at an excluded parent",
  );
  assert.equal(excludes(".env", false, rules), true, "and .env stays out");
  assert.equal(
    excludes("docs/.env.example", false, rules),
    false,
    "including below a directory nobody excluded",
  );
});

test("an excluded folder takes everything under it, however deep", () => {
  const rules = layers(["node_modules/", "!keep.js"].join("\n"));
  assert.equal(excludes("node_modules/left-pad/keep.js", false, rules), true);
  assert.equal(excludes("node_modules/a/b/c/keep.js", false, rules), true);
  assert.equal(excludes("src/keep.js", false, rules), false);
});

test("re-including the directory itself still lets its contents through", () => {
  /*
    The escape hatch git leaves open, and the one people are told to use:
    unexclude the folder, then exclude what you do not want inside it.
  */
  const rules = layers(["build/", "!build/", "build/tmp/"].join("\n"));
  assert.equal(excludes("build/keep.txt", false, rules), false);
  assert.equal(excludes("build/tmp/thing.o", false, rules), true);
});

test("re-including a folder does not re-include what is in it", () => {
  /*
    The other half of that escape hatch, and the half that bites. Opening a
    folder makes git willing to look inside; it says nothing about what is
    found there. A keep aimed at one file inside Unity's package cache writes
    a negation for each folder on the way down, and a matcher that let those
    answer for files as well as folders released all 28,355 of them.
  */
  const rules = layers(
    [
      "/[Ll]ibrary/**",
      "!Library/PackageCache/",
      "!Library/PackageCache/a.package/",
      "!Library/PackageCache/a.package/Editor/",
      "!Library/PackageCache/a.package/Editor/needed.cs",
    ].join("\n"),
  );

  assert.equal(
    excludes("Library/PackageCache/a.package/Editor/needed.cs", false, rules),
    false,
    "the file the keep was for",
  );
  assert.equal(
    excludes("Library/PackageCache/a.package/other.cs", false, rules),
    true,
    "a sibling rode out on the folder's negation",
  );
  assert.equal(
    excludes("Library/PackageCache/b.package/thing.dat", false, rules),
    true,
    "and so did the rest of the cache",
  );
});

test("a negation is only followed into folders it could reach", () => {
  /*
    The rule that keeps Unity's meta files spans separators, and the check
    for "could a negation rescue something in here" answered yes to any rule
    containing one. So every scan of every Unity project descended into
    `Library` — 45,000 files, pruned by the rules and read anyway — because a
    rule about `Assets` might conceivably have applied.

    It could not. This is the difference between could-not and might, and it
    has to stay exact in both directions: saying no where the answer is maybe
    would drop a file somebody asked to keep.
  */
  const rules = layers(["/[Ll]ibrary/", "/[Aa]ssets/", "!/[Aa]ssets/**/*.meta"].join(NEWLINE));

  assert.equal(
    negationReachesInto("Library", rules),
    false,
    "a rule about Assets sent the scan into Library",
  );
  assert.equal(
    negationReachesInto("Assets", rules),
    true,
    "and the folder it is actually about must still be entered",
  );
  assert.equal(
    negationReachesInto("Assets/Models", rules),
    true,
    "including well below it, which is what the ** is for",
  );
});

test("a bare negation is still followed everywhere", () => {
  /* `!keep.txt` is matched against every segment, so it reaches anywhere. */
  const rules = layers(["build/", "!keep.txt"].join(NEWLINE));
  assert.equal(negationReachesInto("build", rules), true);
  assert.equal(negationReachesInto("build/deep/deeper", rules), true);
});

test("ordinary files are unaffected", () => {
  const rules = layers(["*.log", "dist/"].join("\n"));
  assert.equal(excludes("src/main.py", false, rules), false);
  assert.equal(excludes("README.md", false, rules), false);
  assert.equal(excludes("server.log", false, rules), true);
  assert.equal(excludes("dist/app.js", false, rules), true);
});

/**
 * Character classes, which every engine's published ignore file is made of.
 *
 * `*`, `**` and `?` were understood and `[...]` was not — it was escaped into
 * a literal, so `/[Ll]ibrary/` matched a directory genuinely called
 * "[Ll]ibrary" and nothing else. The consequence was quiet and large: the
 * official Unity, Unreal and Godot templates are written entirely in this
 * form, and so is the Unity preset this application ships, so applying either
 * excluded nothing while looking exactly as though it had.
 */
test("a character class matches any of its members", () => {
  const rules = parseRules("/[Ll]ibrary/\n");
  assert.equal(excludes("Library", true, [{ base: "", rules }]), true);
  assert.equal(excludes("library", true, [{ base: "", rules }]), true);
  assert.equal(excludes("Lubrary", true, [{ base: "", rules }]), false);
});

test("a negated class matches anything else, but never a separator", () => {
  const rules = parseRules("[!x]og.txt\n");
  assert.equal(excludes("dog.txt", false, [{ base: "", rules }]), true);
  assert.equal(excludes("xog.txt", false, [{ base: "", rules }]), false);
});

test("an unclosed bracket is a bracket, not a broken rule", () => {
  const rules = parseRules("[unclosed.txt\n");
  assert.equal(excludes("[unclosed.txt", false, [{ base: "", rules }]), true);
});
