/** Ignore/keep rule parsing and matching, with gitignore precedence. */

export type Rule = {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
};

/** Names that can never form part of a version, whatever their type. */
export const UNCOUNTED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".coderook",
  /* The local history `cbx init` keeps; saving it into itself would never end. */
  ".cbx",
]);

/**
 * Whether an entry is version-control plumbing rather than project content.
 *
 * This deliberately ignores whether the entry is a directory: inside a linked
 * git worktree `.git` is a *file* holding an absolute path to the real
 * repository, which is both useless elsewhere and a leak of a local path.
 */
export function isUncounted(name: string): boolean {
  return UNCOUNTED_DIRECTORIES.has(name);
}

export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split(/\r?\n/)) {
    let value = line.trim();
    if (!value || value.startsWith("#")) continue;
    const negated = value.startsWith("!");
    if (negated) value = value.slice(1);
    if (!value) continue;
    const directoryOnly = value.endsWith("/");
    value = value.replace(/\/+$/, "");
    const anchored = value.startsWith("/");
    value = value.replace(/^\/+/, "");
    if (value) rules.push({ pattern: value, negated, directoryOnly, anchored });
  }
  return rules;
}

/** Translate one glob segment into a regular expression source. */
function globToSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\" && index + 1 < pattern.length) {
      /*
        A backslash means the next character is a character, not syntax.
        It is how a file genuinely called `#notes.txt` or `important!.md`
        is written, and how a space is kept at the end of a name. Patterns
        use forward slashes throughout, so a backslash is never a separator
        here and always an escape.
      */
      const literal = pattern[index + 1]!;
      source += literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
      continue;
    }
    if (character === "[") {
      /*
        A character class, which every engine's published ignore file is
        written in: `/[Ll]ibrary/`, `/[Bb]uild/`, `/[Oo]bj/`. Without this
        they were escaped into literals and matched a directory genuinely
        called "[Ll]ibrary" — so pasting the official Unity template, or
        applying the one this application ships, excluded nothing at all and
        said nothing about it.

        A `]` straight after the bracket, or after a leading negation, is a
        literal `]` rather than the end of the class — which is how git and
        the shell both read it.
      */
      let end = index + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end += 1;
      if (pattern[end] === "]") end += 1;
      while (end < pattern.length && pattern[end] !== "]") end += 1;
      if (end < pattern.length) {
        const inside = pattern.slice(index + 1, end);
        const negated = inside.startsWith("!") || inside.startsWith("^");
        const members = (negated ? inside.slice(1) : inside).replace(
          /[\\\^\]]/g,
          "\\$&",
        );
        /*
          A class never spans directories, so a negated one excludes the
          separator too — otherwise `[!a]` would match a slash and a pattern
          for one segment would quietly reach into the next.
        */
        source += negated ? `[^/${members}]` : `[${members}]`;
        index = end;
        continue;
      }
      source += "\\[";
      continue;
    }
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        // A trailing slash after ** should not require one in the subject.
        if (pattern[index + 1] === "/") index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}

const cache = new Map<string, RegExp>();

function matcher(pattern: string): RegExp {
  let expression = cache.get(pattern);
  if (!expression) {
    expression = new RegExp(`^${globToSource(pattern)}$`);
    cache.set(pattern, expression);
  }
  return expression;
}

/** A directory pattern with or without its trailing slash is the same rule. */
function trailingSlashOff(pattern: string): string {
  let end = pattern.length;
  while (end > 0 && pattern[end - 1] === "/") end -= 1;
  return pattern.slice(0, end);
}

export function ruleMatches(
  relativePath: string,
  isDirectory: boolean,
  rule: Rule,
): boolean {
  const expression = matcher(rule.pattern);
  if (rule.directoryOnly) {
    /*
      A rule written `dir/` speaks about directories and about nothing else.
      Everything under an excluded directory goes too, but that is git
      declining to look inside it rather than the pattern reaching down, and
      the difference shows the moment a later rule re-includes the directory:
      `build/` then `!build/` leaves `build/keep.txt` travelling, which is the
      escape hatch people are told to use. It shows again in reverse, which is
      how this was found — asking `!Library/PackageCache/a.package/` about a
      file let the whole cache out of a folder only meant to be opened.

      So the pattern answers only for directories, and a file's ancestors are
      asked separately, outermost in, by `decidingRule`.
    */
    if (!isDirectory) return false;
    const bare = trailingSlashOff(rule.pattern);
    if (rule.anchored || bare.includes("/")) return expression.test(relativePath);
    const own = relativePath.split("/").pop() ?? relativePath;
    return expression.test(own);
  }
  if (rule.anchored || rule.pattern.includes("/")) {
    return expression.test(relativePath);
  }
  return relativePath.split("/").some((segment) => expression.test(segment));
}

/** The last matching rule wins, as it does in gitignore. */
export function lastMatchingRule(
  relativePath: string,
  isDirectory: boolean,
  rules: Rule[],
): Rule | null {
  let found: Rule | null = null;
  for (const rule of rules) {
    if (ruleMatches(relativePath, isDirectory, rule)) found = rule;
  }
  return found;
}

/**
 * One `.gitignore` and the directory it governs. A nested file only applies
 * to paths beneath it, and being deeper, it has the final say.
 */
export type RuleLayer = {
  /** Directory the file sits in, relative and POSIX-separated; "" at the root. */
  base: string;
  rules: Rule[];
};

/**
 * The layers that could speak about this path, shallowest first, so a plain
 * last-match-wins scan across them gives deeper files the final word.
 */
function layersFor(relativePath: string, layers: RuleLayer[]): RuleLayer[] {
  return layers
    .filter(
      (layer) => !layer.base || relativePath.startsWith(`${layer.base}/`),
    )
    .sort((left, right) => left.base.length - right.base.length);
}

/** The last rule that matched, across every layer that governs the path. */
export function decide(
  relativePath: string,
  isDirectory: boolean,
  layers: RuleLayer[],
): Rule | null {
  let found: Rule | null = null;
  for (const layer of layersFor(relativePath, layers)) {
    // A nested file's patterns are written relative to its own directory.
    const scoped = layer.base
      ? relativePath.slice(layer.base.length + 1)
      : relativePath;
    const matched = lastMatchingRule(scoped, isDirectory, layer.rules);
    if (matched) found = matched;
  }
  return found;
}

/**
 * Whether these layers exclude the path, negations included.
 *
 * An excluded directory takes everything under it, whatever a later negation
 * says. This is git's rule — "it is not possible to re-include a file if a
 * parent directory of that file is excluded" — and it is followed here for a
 * plain reason: the file is called .gitignore, git reads it too, and a rule
 * that means one thing to one reader and something else to the other is worse
 * than either behaviour on its own.
 *
 * It was the other way once, deliberately, on the reasoning that somebody
 * writing `!` meant it. What that produced was a project excluding a folder
 * and publishing two files out of it anyway, because an unrelated
 * `!.env.example` further down reached inside — git had ignored them, so
 * nothing else in the toolchain gave any sign. Being more permissive than git
 * is the dangerous direction to differ in: it uploads what somebody thought
 * they had excluded.
 */
/**
 * The rule that settles this path, counting the directories above it.
 *
 * A directory rule is written about the directory — `/[Ll]ibrary/` matches
 * `Library`, not `Library/Artifacts/f1.dat` — so anything asking only about
 * the file finds no rule and calls it included. The upload has always walked
 * the ancestors; the filter screen asked about the file alone, and so showed
 * a Unity project's whole import cache as going up when the save would have
 * left every byte of it behind.
 *
 * Returned as the rule rather than a yes or no, because the screen names the
 * line responsible — "Library/ — 400 files" is the useful form, and a boolean
 * cannot say it.
 */
/**
 * Answers about folders, remembered for as long as the rules hold still.
 *
 * Every file asks about each of its ancestors, and a folder of four hundred
 * files asks the same question about that folder four hundred times. Over a
 * real Unity project that is a quarter of a million rule evaluations where
 * two thousand would do. The caller owns the map, so it lasts exactly as long
 * as one evaluation and cannot outlive an edit to the rules.
 */
export type FolderAnswers = Map<string, Rule | null>;

export function decidingRule(
  relativePath: string,
  isDirectory: boolean,
  layers: RuleLayer[],
  remembered?: FolderAnswers,
): Rule | null {
  /*
    Ancestors first, outermost in. The moment one is excluded the answer is
    settled and nothing below it can appeal.
  */
  const parts = relativePath.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) {
    const ancestor = parts.slice(0, depth).join("/");
    let above: Rule | null;
    if (remembered && remembered.has(ancestor)) {
      above = remembered.get(ancestor) ?? null;
    } else {
      above = decide(ancestor, true, layers);
      remembered?.set(ancestor, above);
    }
    if (above && !above.negated) return above;
  }
  return decide(relativePath, isDirectory, layers);
}

export function excludes(
  relativePath: string,
  isDirectory: boolean,
  layers: RuleLayer[],
): boolean {
  const rule = decidingRule(relativePath, isDirectory, layers);
  return Boolean(rule && !rule.negated);
}

/**
 * Whether an anchored pattern could name anything inside this directory.
 *
 * Walked a segment at a time against the directory's own segments. A `**`
 * makes everything below it possible and settles the question; a segment that
 * simply does not match settles it the other way. Where the pattern runs out
 * first it is left as possible, because this only ever needs to be certain
 * when it says no.
 */
function couldDescendTo(pattern: string, directory: string): boolean {
  const wanted = pattern.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  const here = directory.split("/").filter(Boolean);
  for (let at = 0; at < here.length; at += 1) {
    const part = wanted[at];
    if (part === undefined) return true;
    if (part === "**") return true;
    if (!matcher(part).test(here[at]!)) return false;
  }
  return true;
}

/**
 * Whether a negation could rescue something inside this directory.
 *
 * Skipping an excluded directory outright is what keeps a scan fast, but a
 * `!` rule exists precisely to bring something back from inside one, so the
 * subtree can only be skipped when no negation could apply below it.
 */
export function negationReachesInto(
  relativePath: string,
  layers: RuleLayer[],
): boolean {
  for (const layer of layers) {
    // A nested file below this directory can always speak about its contents.
    if (layer.base && layer.base.startsWith(`${relativePath}/`)) return true;
    for (const rule of layer.rules) {
      if (!rule.negated) continue;
      const prefix = layer.base ? `${layer.base}/` : "";
      // A bare glob is matched against every segment, so it reaches anywhere.
      if (!rule.anchored && !rule.pattern.includes("/")) return true;
      // A ** used to end the question here, and that one line was the
      // reason a scan read every directory in the project.
      //
      // The starter carries the negation that keeps Unity's meta files, and
      // it is written with a ** in the middle, so `includes` said yes to
      // it for every directory on disk. `Library/`, excluded and 45,000
      // files deep, was descended into on every scan of every Unity
      // project, because a rule about `Assets` might conceivably have
      // reached in.
      //
      // It cannot: the pattern is anchored and its first segment is
      // `[Aa]ssets`, which does not match `Library`. Comparing segment by
      // segment answers that exactly, and stops only where a **
      // genuinely makes the rest unknowable.
      if (!couldDescendTo(`${prefix}${rule.pattern}`, relativePath)) continue;
      if (rule.pattern.includes("**")) return true;
      const target = `${prefix}${rule.pattern.replace(/\/+$/, "")}`;
      if (target === relativePath || target.startsWith(`${relativePath}/`)) {
        return true;
      }
    }
  }
  return false;
}

export function isIgnored(
  relativePath: string,
  isDirectory: boolean,
  rules: Rule[],
): boolean {
  const rule = lastMatchingRule(relativePath, isDirectory, rules);
  return Boolean(rule && !rule.negated);
}
