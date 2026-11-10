// Cross-test: the engine's folder walk against the TypeScript one, under many rule sets.
//
//   CBX_DIST=<compiled cbx>  ENGINE=<cbx-engine>  node rules-cross.mjs [--templates N] [--fuzz N] [--plant <scratch>] <folder>...
//
// For every folder, each rule set is the folder's own rules (readRules), then N of the built-in
// ignore templates, then N rule sets generated from the folder's real names (negations,
// anchors, **, classes, folder-only rules, escapes, stray spaces). For each one:
//   - the files and sizes must equal surveyFiles(root, rules);
//   - the order must equal the order changedFiles walks in (outcome.sizes), which decides
//     what its 20,000-row cap keeps.
// With --plant, a copy of each folder is made under <scratch> and random .gitignore files are
// planted in random subfolders for each fuzz set, so nested layers are tested too.
// Prints one JSON line per folder and exits non-zero on any difference.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIST = process.env.CBX_DIST;
const ENGINE = process.env.ENGINE;
if (!DIST || !ENGINE) throw new Error("set CBX_DIST and ENGINE");
const load = (relative) => import(pathToFileURL(path.join(DIST, relative)).href);
const worktree = await load("core/worktree.js");
const { IGNORE_TEMPLATES } = await load("core/ignore_templates.js");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const templateCount = Number(option("--templates", 25));
const fuzzCount = Number(option("--fuzz", 25));
const plant = option("--plant", null);
const folders = args;

let seed = 20261109;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (list) => list[Math.floor(rand() * list.length)];

function engineScan(root, rules, tracked) {
  const input = JSON.stringify({
    root,
    shared: rules.shared,
    local: rules.local,
    trackedFiles: tracked ? [...tracked.files] : null,
    trackedFolders: tracked ? [...tracked.folders] : null,
    /* SCAN_EXACT=0: the listing's sizes and times, as status asks for; closed files must agree with a stat. */
    exact: process.env.SCAN_EXACT !== "0",
  });
  const run = spawnSync(ENGINE, ["scan"], { input, maxBuffer: 1 << 30, encoding: "utf8" });
  if (run.status !== 0) return { error: run.stderr.trim() };
  const answer = JSON.parse(run.stdout);
  return answer.invalidRule ? { error: answer.invalidRule } : answer;
}

/* Real names from the folder, for rules that actually match something. */
function namesOf(root) {
  const dirs = [], files = [], exts = new Set(), paths = [];
  const visit = (dir, rel, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { dirs.push(e.name); paths.push(r); if (depth < 6 && dirs.length < 4000) visit(path.join(dir, e.name), r, depth + 1); }
      else { files.push(e.name); const dot = e.name.lastIndexOf("."); if (dot > 0) exts.add(e.name.slice(dot)); }
    }
  };
  visit(root, "", 0);
  return { dirs: dirs.length ? dirs : ["x"], files: files.length ? files : ["x"], exts: exts.size ? [...exts] : [".x"], paths: paths.length ? paths : ["x"] };
}

function fuzzRule(names) {
  const d = pick(names.dirs), f = pick(names.files), x = pick(names.exts), p = pick(names.paths);
  const half = (s) => s.slice(0, Math.max(1, Math.floor(s.length / 2)));
  const forms = [
    () => d, () => `${d}/`, () => `/${d}`, () => `/${d}/`, () => `*${x}`, () => `${half(f)}*`, () => `*${f.slice(-3)}`,
    () => `?${d.slice(1)}`, () => `[${d[0].toLowerCase()}${d[0].toUpperCase()}]${d.slice(1)}`, () => `[!a-m]${d.slice(1)}`,
    () => `${p}/`, () => `/${p}`, () => `${p}/**`, () => `**/${f}`, () => `${p.split("/")[0]}/**/${f}`, () => `**/${d}/`,
    () => `!${d}`, () => `!${d}/`, () => `!*${x}`, () => `!/${p}`, () => `!**/${f}`, () => `!${p}/**`,
    () => `\\#${f}`, () => `${f}   `, () => `  ${d}`, () => `# ${d}`, () => "", () => `${d}/*`, () => `${d}/*/`,
    () => "*", () => "**/", () => "!*/", () => `${half(d)}?*/`, () => `*.[a-c]*`, () => `${p.split("/").slice(0, 2).join("/")}`,
  ];
  return pick(forms)();
}
const fuzzRules = (names, lines) => Array.from({ length: lines }, () => fuzzRule(names)).join(rand() < 0.5 ? "\n" : "\r\n");

let failures = 0;
for (const original of folders) {
  let root = original;
  if (plant) {
    root = path.join(plant, path.basename(original).replace(/\W+/g, "-"));
    rmSync(root, { recursive: true, force: true });
    mkdirSync(path.dirname(root), { recursive: true });
    cpSync(original, root, { recursive: true });
  }
  const names = namesOf(root);
  const tracked = await worktree.gitTracked(root);
  const own = await worktree.readRules(root);
  const sets = [{ label: "own rules", rules: own }];
  const templates = Object.values(IGNORE_TEMPLATES);
  for (let k = 0; k < templateCount; k++) {
    const t = templates[Math.floor(rand() * templates.length)];
    sets.push({ label: `template ${t.name}`, rules: { shared: t.body, local: "" } });
  }
  for (let k = 0; k < fuzzCount; k++) {
    sets.push({ label: `fuzz ${k}`, rules: { shared: fuzzRules(names, 3 + Math.floor(rand() * 12)), local: rand() < 0.3 ? fuzzRules(names, 3) : "" }, plantLayers: Boolean(plant) });
  }
  const report = { folder: original, sets: 0, differing: 0, files: 0, tsMs: 0, engineMs: 0 };
  for (const set of sets) {
    /* Nested rules: a few random subfolders get a .gitignore of their own, removed again afterwards. */
    const planted = [];
    if (set.plantLayers) {
      for (let k = 0; k < 4; k++) {
        const where = path.join(root, ...pick(names.paths).split("/"));
        const file = path.join(where, ".gitignore");
        try { writeFileSync(file, fuzzRules(names, 4), { flag: "wx" }); planted.push(file); } catch { /* exists or not a folder */ }
      }
    }
    let started = performance.now();
    let ts, order, tsError = null;
    try {
      ts = await worktree.surveyFiles(root, set.rules);
      const outcome = { limit: 0, listed: 0, total: 0, sizes: [] };
      await worktree.changedFiles(root, set.rules, null, "add-and-update", undefined, outcome);
      order = outcome.sizes.map((one) => one.path);
    } catch (error) {
      tsError = String(error?.message ?? error);
    }
    report.tsMs += performance.now() - started;
    started = performance.now();
    const native = engineScan(root, set.rules, tracked);
    report.engineMs += performance.now() - started;
    for (const file of planted) rmSync(file, { force: true });
    report.sets += 1;
    if (tsError || native.error) {
      /* Both must refuse, or neither. */
      if (!(tsError && native.error)) { failures++; report.differing++; console.error("DIFFERENT", original, set.label, "ts:", tsError, "engine:", native.error); }
      continue;
    }
    const tsSorted = ts.map((f) => `${f.path}\t${f.size}`).sort();
    const enSorted = native.files.map((f) => `${f.path}\t${f.size}`).sort();
    const sameSet = tsSorted.length === enSorted.length && tsSorted.every((v, i) => v === enSorted[i]);
    const sameOrder = order.length === native.files.length && order.every((v, i) => v === native.files[i].path);
    report.files += tsSorted.length;
    if (!sameSet || !sameOrder) {
      failures++; report.differing++;
      const a = new Set(tsSorted), b = new Set(enSorted);
      console.error("DIFFERENT", original, set.label, { sameSet, sameOrder, onlyTs: tsSorted.filter((v) => !b.has(v)).slice(0, 3), onlyEngine: enSorted.filter((v) => !a.has(v)).slice(0, 3) });
      console.error("RULES", JSON.stringify(set.rules));
    }
  }
  report.tsMs = Math.round(report.tsMs);
  report.engineMs = Math.round(report.engineMs);
  console.log(JSON.stringify(report));
  if (plant) rmSync(root, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
