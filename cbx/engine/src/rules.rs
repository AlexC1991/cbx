//! The ignore rules, decided exactly as `cbx/src/core/rules.ts` decides them.
//!
//! Which files a save holds is part of what must not change, so this is a
//! port, not a re-imagining: the same parsing (JavaScript's `trim`, the same
//! slash handling), the same glob-to-pattern translation, the same
//! "outermost folder first, last matching rule wins" order, the same answers
//! for negations that reach into excluded folders. Where the TypeScript has a
//! quirk (`a/**b` also matching `a/xb`, say) the quirk is kept; the
//! cross-tests compare the two on real folders and rule sets.
//!
//! JavaScript regular expressions are the reference. The translation here
//! produces only the constructs both engines read the same way: anchors,
//! "any run of non-slash", "any single non-slash", character classes written
//! out character by character, and literals. JavaScript's `.` also refuses
//! CR, U+2028 and U+2029, so `**` is written as a class refusing those too.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::{Arc, RwLock};

use regex::{Regex, RegexSet};

#[derive(Clone, Debug)]
pub struct Rule {
    pub pattern: String,
    pub negated: bool,
    pub directory_only: bool,
    pub anchored: bool,
}

/// Names that can never form part of a version, whatever their type.
pub const UNCOUNTED: [&str; 5] = [".git", ".hg", ".svn", ".coderook", ".cbx"];

pub fn is_uncounted(name: &str) -> bool {
    UNCOUNTED.contains(&name)
}

/// What JavaScript's `String.prototype.trim` removes: WhiteSpace and LineTerminator.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// `parseRules`: one rule per line that is not blank or a comment.
pub fn parse_rules(text: &str) -> Vec<Rule> {
    let mut rules = Vec::new();
    /* text.split(/\r?\n/) */
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let mut value = js_trim(line);
        if value.is_empty() || value.starts_with('#') {
            continue;
        }
        let negated = value.starts_with('!');
        if negated {
            value = &value[1..];
        }
        if value.is_empty() {
            continue;
        }
        let directory_only = value.ends_with('/');
        let value = value.trim_end_matches('/');
        let anchored = value.starts_with('/');
        let value = value.trim_start_matches('/');
        if !value.is_empty() {
            rules.push(Rule { pattern: value.to_string(), negated, directory_only, anchored });
        }
    }
    rules
}

/// A character as a pattern literal, safe anywhere.
fn literal(out: &mut String, c: char) {
    out.push_str(&format!("\\x{{{:x}}}", c as u32));
}

/// `globToSource`, producing a pattern for the regex crate with JavaScript's meaning.
fn glob_to_source(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut source = String::new();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character == '\\' && index + 1 < chars.len() {
            literal(&mut source, chars[index + 1]);
            index += 2;
            continue;
        }
        if character == '[' {
            let mut end = index + 1;
            if end < chars.len() && (chars[end] == '!' || chars[end] == '^') {
                end += 1;
            }
            if end < chars.len() && chars[end] == ']' {
                end += 1;
            }
            while end < chars.len() && chars[end] != ']' {
                end += 1;
            }
            if end < chars.len() {
                let inside: Vec<char> = chars[index + 1..end].to_vec();
                let negated = matches!(inside.first(), Some('!') | Some('^'));
                let members = if negated { &inside[1..] } else { &inside[..] };
                source.push_str(&class_source(members, negated));
                index = end + 1;
                continue;
            }
            literal(&mut source, '[');
            index += 1;
            continue;
        }
        if character == '*' {
            if chars.get(index + 1) == Some(&'*') {
                /* JavaScript's `.`: anything but LF, CR, U+2028, U+2029. */
                source.push_str("[^\\n\\r\\x{2028}\\x{2029}]*");
                index += 2;
                if chars.get(index) == Some(&'/') {
                    index += 1;
                }
            } else {
                source.push_str("[^/]*");
                index += 1;
            }
            continue;
        }
        if character == '?' {
            source.push_str("[^/]");
        } else {
            literal(&mut source, character);
        }
        index += 1;
    }
    source
}

/// A character class with the meaning JavaScript gives `[members]` (or `[^/members]`) after the
/// TypeScript escapes `\`, `^` and `]` in it: every member is a literal character, and `a-b`
/// between two of them is a range.
fn class_source(members: &[char], negated: bool) -> String {
    let mut out = String::from(if negated { "[^/" } else { "[" });
    let mut items: Vec<(char, Option<char>)> = Vec::new();
    let mut at = 0;
    while at < members.len() {
        let c = members[at];
        if at + 2 < members.len() && members[at + 1] == '-' {
            items.push((c, Some(members[at + 2])));
            at += 3;
        } else {
            items.push((c, None));
            at += 1;
        }
    }
    let mut empty = true;
    for (from, to) in items {
        match to {
            Some(to) if to < from => {
                /* JavaScript refuses the whole expression, and the TypeScript walk fails with it. */
                return String::from(INVALID);
            }
            Some(to) => out.push_str(&format!("\\x{{{:x}}}-\\x{{{:x}}}", from as u32, to as u32)),
            None => out.push_str(&format!("\\x{{{:x}}}", from as u32)),
        }
        empty = false;
    }
    if empty && !negated {
        /* `[]` in JavaScript matches nothing. */
        return String::from("[^\\x{0}-\\x{10ffff}]");
    }
    out.push(']');
    out
}

/// Marks a pattern JavaScript would refuse to compile.
const INVALID: &str = "(INVALID)";

/// A string as JavaScript sees it without the `u` flag: one character per UTF-16 unit.
///
/// A character outside the Basic Multilingual Plane is two units there, so `?` matches half of
/// one. Each surrogate is stood in for by a code point from U+100000 on; since every real
/// character up there is itself split, those stand-ins mean exactly the surrogates.
fn js_units(text: &str) -> std::borrow::Cow<'_, str> {
    if text.chars().all(|c| (c as u32) < 0x10000) {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        let mut units = [0u16; 2];
        for unit in c.encode_utf16(&mut units).iter() {
            let unit = *unit as u32;
            let stand_in = if (0xd800..0xe000).contains(&unit) { 0x10_0000 + unit - 0xd800 } else { unit };
            out.push(char::from_u32(stand_in).unwrap());
        }
    }
    std::borrow::Cow::Owned(out)
}

/// `matcher`, cached by pattern.
pub struct Matchers {
    cache: RwLock<HashMap<String, Option<Regex>>>,
    /// Set when a pattern JavaScript would refuse was asked about: the walk must then fail, as the TypeScript one does.
    pub invalid: std::sync::atomic::AtomicBool,
}

impl Default for Matchers {
    fn default() -> Self {
        Matchers { cache: RwLock::new(HashMap::new()), invalid: std::sync::atomic::AtomicBool::new(false) }
    }
}

impl Matchers {
    pub fn test(&self, pattern: &str, subject: &str) -> bool {
        let known = self.cache.read().unwrap().get(pattern).cloned();
        let regex = match known {
            Some(found) => found,
            None => {
                let source = glob_to_source(&js_units(pattern));
                let built = if source.contains(INVALID) { None } else { Regex::new(&format!("^(?:{source})$")).ok() };
                self.cache.write().unwrap().insert(pattern.to_string(), built.clone());
                built
            }
        };
        match regex {
            Some(regex) => regex.is_match(&js_units(subject)),
            None => {
                self.invalid.store(true, std::sync::atomic::Ordering::Relaxed);
                false
            }
        }
    }

    pub fn saw_invalid(&self) -> bool {
        self.invalid.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Segment,
    OwnName,
    WholePath,
}

fn kind_of(rule: &Rule) -> Kind {
    if rule.directory_only {
        if rule.anchored || rule.pattern.contains('/') { Kind::WholePath } else { Kind::OwnName }
    } else if rule.anchored || rule.pattern.contains('/') {
        Kind::WholePath
    } else {
        Kind::Segment
    }
}

/// A pattern compiled once: the regular expression JavaScript would build, or None where
/// JavaScript would refuse to compile it.
fn compile(pattern: &str) -> Option<Regex> {
    let source = glob_to_source(&js_units(pattern));
    if source.contains(INVALID) {
        return None;
    }
    Regex::new(&format!("^(?:{source})$")).ok()
}

/// One `.gitignore` and the folder it governs, compiled once.
///
/// Rules that only ever look at single names keep `RuleIndex`'s memory: for each name seen,
/// which of them match it, since those questions repeat endlessly across a walk (`core`,
/// `*.pfx`). Rules that look at the whole path are asked together, in one pass per path.
pub struct Layer {
    pub base: String,
    pub rules: Vec<Rule>,
    kinds: Vec<Kind>,
    /* The single-name rules, each compiled. */
    named: Vec<(usize, Option<Regex>)>,
    answers: RwLock<HashMap<String, Arc<[usize]>>>,
    /* The whole-path rules, asked together; `whole_rules[i]` is the rule behind set entry i. */
    whole: Option<RegexSet>,
    whole_rules: Vec<usize>,
    /* Whether any rule here is one JavaScript would refuse; asking this layer anything then fails. */
    invalid: bool,
}

impl Layer {
    pub fn new(base: String, rules: Vec<Rule>) -> Self {
        let kinds: Vec<Kind> = rules.iter().map(kind_of).collect();
        let mut invalid = false;
        let mut named = Vec::new();
        let mut whole_rules = Vec::new();
        let mut whole_sources = Vec::new();
        for (at, rule) in rules.iter().enumerate() {
            let compiled = compile(&rule.pattern);
            if compiled.is_none() {
                invalid = true;
            }
            if kinds[at] == Kind::WholePath {
                if let Some(regex) = compiled {
                    whole_rules.push(at);
                    whole_sources.push(regex.as_str().to_string());
                }
            } else {
                named.push((at, compiled));
            }
        }
        let whole = if whole_sources.is_empty() { None } else { RegexSet::new(&whole_sources).ok() };
        if whole.is_none() && !whole_sources.is_empty() {
            invalid = true;
        }
        Layer { base, rules, kinds, named, answers: RwLock::new(HashMap::new()), whole, whole_rules, invalid }
    }

    fn named_matches(&self, name: &str) -> Arc<[usize]> {
        if let Some(found) = self.answers.read().unwrap().get(name) {
            return found.clone();
        }
        let found: Arc<[usize]> = self
            .named
            .iter()
            .filter(|(_, regex)| regex.as_ref().is_some_and(|regex| regex.is_match(name)))
            .map(|(at, _)| *at)
            .collect();
        self.answers.write().unwrap().insert(name.to_string(), found.clone());
        found
    }
}

impl std::fmt::Debug for Layer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Layer").field("base", &self.base).field("rules", &self.rules).finish()
    }
}

/// `lastMatchingRule`: the last rule in the layer that speaks about this path.
pub fn last_matching_rule<'a>(matchers: &Matchers, path: &str, is_directory: bool, layer: &'a Layer) -> Option<&'a Rule> {
    if layer.rules.is_empty() {
        return None;
    }
    if layer.invalid {
        matchers.invalid.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let units = js_units(path);
    let mut last: Option<usize> = None;
    let mut consider = |at: usize| {
        if last.is_none_or(|known| at > known) {
            last = Some(at);
        }
    };
    let count = units.split('/').count();
    for (at, segment) in units.split('/').enumerate() {
        for &hit in layer.named_matches(segment).iter() {
            match layer.kinds[hit] {
                Kind::Segment => consider(hit),
                Kind::OwnName if is_directory && at == count - 1 => consider(hit),
                _ => {}
            }
        }
    }
    if let Some(set) = &layer.whole {
        for entry in set.matches(&units).iter() {
            let at = layer.whole_rules[entry];
            if !(layer.rules[at].directory_only && !is_directory) {
                consider(at);
            }
        }
    }
    last.map(|at| &layer.rules[at])
}

/// `decide`: every layer that governs the path, shallowest first; the deepest match has the say.
pub fn decide<'a, L: Deref<Target = Layer>>(matchers: &Matchers, path: &str, is_directory: bool, layers: &'a [L]) -> Option<&'a Rule> {
    let mut applying: Vec<&Layer> = layers
        .iter()
        .map(|layer| &**layer)
        .filter(|layer| layer.base.is_empty() || (path.starts_with(&layer.base) && path[layer.base.len()..].starts_with('/')))
        .collect();
    /* A stable sort, as JavaScript's is. */
    applying.sort_by_key(|layer| layer.base.len());
    let mut found = None;
    for layer in applying {
        let scoped = if layer.base.is_empty() { path } else { &path[layer.base.len() + 1..] };
        if let Some(rule) = last_matching_rule(matchers, scoped, is_directory, layer) {
            found = Some(rule);
        }
    }
    found
}

/// What each folder was decided to be during one walk, by rule position (None: no rule).
pub type FolderAnswers = RwLock<HashMap<String, Option<usize>>>;

/// `decidingRule` with `FolderAnswers`: ancestors outermost first, and an excluded one settles it.
pub fn deciding_rule<'a, L: Deref<Target = Layer>>(
    matchers: &Matchers,
    path: &str,
    is_directory: bool,
    layers: &'a [L],
    remembered: Option<&FolderAnswers>,
) -> Option<&'a Rule> {
    /* Each ancestor is the path up to one of its slashes, outermost first. */
    for (cut, _) in path.match_indices('/') {
        let ancestor = &path[..cut];
        let known = remembered.and_then(|memo| memo.read().unwrap().get(ancestor).copied());
        let above = match known {
            Some(index) => index.map(|i| rule_at(layers, i)),
            None => {
                let answer = decide(matchers, ancestor, true, layers);
                if let Some(memo) = remembered {
                    memo.write().unwrap().insert(ancestor.to_string(), answer.map(|rule| index_of(layers, rule)));
                }
                answer
            }
        };
        if let Some(rule) = above {
            if !rule.negated {
                return Some(rule);
            }
        }
    }
    decide(matchers, path, is_directory, layers)
}

/* Rules are remembered by position so the memo can be shared between threads. */
fn index_of<L: Deref<Target = Layer>>(layers: &[L], wanted: &Rule) -> usize {
    let mut at = 0;
    for layer in layers {
        for rule in &layer.rules {
            if std::ptr::eq(rule, wanted) {
                return at;
            }
            at += 1;
        }
    }
    usize::MAX
}

fn rule_at<L: Deref<Target = Layer>>(layers: &[L], mut at: usize) -> &Rule {
    for layer in layers {
        if at < layer.rules.len() {
            return &layer.rules[at];
        }
        at -= layer.rules.len();
    }
    unreachable!("a remembered rule is always in the layers it came from")
}

pub fn excludes<L: Deref<Target = Layer>>(
    matchers: &Matchers,
    path: &str,
    is_directory: bool,
    layers: &[L],
    remembered: Option<&FolderAnswers>,
) -> bool {
    deciding_rule(matchers, path, is_directory, layers, remembered).map(|rule| !rule.negated).unwrap_or(false)
}

pub fn could_descend_to(matchers: &Matchers, pattern: &str, directory: &str) -> bool {
    let trimmed = pattern.trim_start_matches('/').trim_end_matches('/');
    let wanted: Vec<&str> = trimmed.split('/').collect();
    let here: Vec<&str> = directory.split('/').filter(|part| !part.is_empty()).collect();
    for (at, segment) in here.iter().enumerate() {
        let Some(part) = wanted.get(at) else { return true };
        if *part == "**" {
            return true;
        }
        if !matchers.test(part, segment) {
            return false;
        }
    }
    true
}

/// `negationReachesInto`: whether a `!` rule could rescue something inside an excluded folder.
pub fn negation_reaches_into<L: Deref<Target = Layer>>(matchers: &Matchers, path: &str, layers: &[L]) -> bool {
    let inside = format!("{path}/");
    for layer in layers {
        if !layer.base.is_empty() && layer.base.starts_with(&inside) {
            return true;
        }
        for rule in &layer.rules {
            if !rule.negated {
                continue;
            }
            let prefix = if layer.base.is_empty() { String::new() } else { format!("{}/", layer.base) };
            if !rule.anchored && !rule.pattern.contains('/') {
                return true;
            }
            if !could_descend_to(matchers, &format!("{prefix}{}", rule.pattern), path) {
                continue;
            }
            if rule.pattern.contains("**") {
                return true;
            }
            let target = format!("{prefix}{}", rule.pattern.trim_end_matches('/'));
            if target == path || target.starts_with(&inside) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layers(text: &str) -> Vec<Arc<Layer>> {
        vec![Arc::new(Layer::new(String::new(), parse_rules(text)))]
    }

    #[test]
    fn the_usual_cases() {
        let m = Matchers::default();
        let l = layers("node_modules/\n*.log\n/build\n!keep.log\n[Ll]ibrary/\ndocs/**/*.tmp\n");
        assert!(excludes(&m, "node_modules", true, &l, None));
        assert!(excludes(&m, "a/node_modules/x.js", false, &l, None));
        assert!(!excludes(&m, "node_modules", false, &l, None));
        assert!(excludes(&m, "a/b.log", false, &l, None));
        assert!(!excludes(&m, "a/keep.log", false, &l, None));
        assert!(excludes(&m, "build", false, &l, None));
        assert!(!excludes(&m, "src/build", false, &l, None));
        assert!(excludes(&m, "Library", true, &l, None));
        assert!(excludes(&m, "library", true, &l, None));
        assert!(excludes(&m, "docs/a/b/c.tmp", false, &l, None));
        assert!(excludes(&m, "docs/c.tmp", false, &l, None));
    }

    #[test]
    fn javascript_units_and_bad_patterns() {
        let m = Matchers::default();
        /* One emoji is two units: "?" does not cover it, "??" does. */
        assert!(!m.test("a?b", "a\u{1f600}b"));
        assert!(m.test("a??b", "a\u{1f600}b"));
        assert!(m.test("*.txt", "\u{1f600}.txt"));
        assert!(!m.saw_invalid());
        assert!(!m.test("[z-a]", "b"));
        assert!(m.saw_invalid());
    }

    #[test]
    fn javascript_trim_and_escapes() {
        let rules = parse_rules("\u{feff}*.bak  \r\n\\#notes.txt\n  # comment\n!\n/\n");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].pattern, "*.bak");
        let m = Matchers::default();
        assert!(m.test(&rules[1].pattern, "#notes.txt"));
        assert!(m.test("[!a]x", "bx") && !m.test("[!a]x", "ax") && !m.test("[!a]x", "/x"));
        assert!(m.test("a?c", "abc") && !m.test("a?c", "a/c"));
    }
}

/// `negationReachesInto` for one walk: the same answers, with what does not depend on the
/// folder worked out once. An unanchored `!name` reaches into every folder, so when there is
/// one the answer is always yes without looking further.
pub struct Negations {
    reaches_everywhere: bool,
    bases: Vec<String>,
    /* (prefix + pattern, pattern has "**", prefix + pattern without trailing slashes) */
    rules: Vec<(String, bool, String)>,
}

impl Negations {
    pub fn new<L: Deref<Target = Layer>>(layers: &[L]) -> Self {
        let mut reaches_everywhere = false;
        let mut bases = Vec::new();
        let mut rules = Vec::new();
        for layer in layers {
            if !layer.base.is_empty() {
                bases.push(layer.base.clone());
            }
            for rule in &layer.rules {
                if !rule.negated {
                    continue;
                }
                if !rule.anchored && !rule.pattern.contains('/') {
                    reaches_everywhere = true;
                }
                let prefix = if layer.base.is_empty() { String::new() } else { format!("{}/", layer.base) };
                rules.push((
                    format!("{prefix}{}", rule.pattern),
                    rule.pattern.contains("**"),
                    format!("{prefix}{}", rule.pattern.trim_end_matches('/')),
                ));
            }
        }
        Negations { reaches_everywhere, bases, rules }
    }

    pub fn reach_into(&self, matchers: &Matchers, path: &str) -> bool {
        /* In the TypeScript a layer below this folder answers first, an unanchored rule next; both are yes. */
        if self.reaches_everywhere {
            return true;
        }
        let inside = format!("{path}/");
        if self.bases.iter().any(|base| base.starts_with(&inside)) {
            return true;
        }
        for (pattern, double_star, target) in &self.rules {
            if !could_descend_to(matchers, pattern, path) {
                continue;
            }
            if *double_star {
                return true;
            }
            if target == path || target.starts_with(&inside) {
                return true;
            }
        }
        false
    }
}
