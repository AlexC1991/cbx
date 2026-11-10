// Cross-test: the native engine against the TypeScript CBX it must match, on real folders.
//
//   CBX_DIST=<compiled cbx>  ENGINE=<cbx-engine binary>  node cross.mjs <scratch dir> <folder>...
//
// For every folder:
//   1. cuts     every file over 8 MiB: chunk ends and names, engine vs chunkBoundaries
//   2. profiles a sample of 1-8 MiB files cut with all five profiles, both ways
//   3. store    the whole folder stored by each into its own "cbx-local 1" store:
//               the same file digests and chunk lists, then each reads the other's store
//   4. delta    random edits of real files: engine deltas applied by the prototype, and the reverse
// Prints one JSON line per folder and exits non-zero on any difference.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIST = process.env.CBX_DIST;
const ENGINE = process.env.ENGINE;
const PROTO = process.env.PROTO_DELTA; // optional: the research prototype's delta.mjs
if (!DIST || !ENGINE) throw new Error("set CBX_DIST and ENGINE");
const load = (relative) => import(pathToFileURL(path.join(DIST, relative)).href);
const chunking = await load("shared/chunking.js");
const { ObjectStore } = await load("local/store.js");
const { storeFile } = await load("local/snapshot.js");
const proto = PROTO ? await import(pathToFileURL(PROTO).href) : null;

const [scratch, ...folders] = process.argv.slice(2);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function engine(args, input) {
  const run = spawnSync(ENGINE, args, { input, maxBuffer: 1 << 30, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`cbx-engine ${args[0]}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function walk(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        try { out.push({ path: path.relative(root, full).split(path.sep).join("/"), size: statSync(full).size }); } catch { /* gone */ }
      }
    }
  };
  visit(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function tsCuts(bytes, profile) {
  const bounds = chunking.chunkBoundaries(bytes, profile);
  const names = [];
  let from = 0;
  for (const end of bounds) { names.push(sha(bytes.subarray(from, end))); from = end; }
  return { bounds, names };
}

const PROFILES = [chunking.MEDIUM_CHUNK_PROFILE, chunking.LARGE_CHUNK_PROFILE, chunking.HUGE_CHUNK_PROFILE, chunking.MICRO_CHUNK_PROFILE, chunking.LEGACY_CHUNK_PROFILE];
let failures = 0;
const fail = (what) => { failures += 1; console.error("DIFFERENT:", what); };

for (const folder of folders) {
  const files = walk(folder).filter((f) => {
    try { closeSync(openSync(path.join(folder, f.path), "r")); return true; } catch { return false; }
  });
  const report = { folder, files: files.length, MB: +(files.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(1) };

  /* 1. Big files, cut both ways. */
  let bigChecked = 0, chunksCompared = 0;
  for (const f of files.filter((f) => f.size >= 8 * 1024 * 1024)) {
    const full = path.join(folder, f.path);
    const bytes = readFileSync(full);
    const profile = chunking.profileForFileSize(bytes.length);
    const ts = tsCuts(bytes, profile);
    const native = engine(["cuts", full]);
    if (native.profile !== profile.id) fail(`${f.path}: profile ${native.profile} vs ${profile.id}`);
    if (JSON.stringify(native.bounds) !== JSON.stringify(ts.bounds)) fail(`${f.path}: chunk ends differ`);
    if (JSON.stringify(native.chunks) !== JSON.stringify(ts.names)) fail(`${f.path}: chunk names differ`);
    if (native.sha256 !== sha(bytes)) fail(`${f.path}: file digest differs`);
    bigChecked += 1; chunksCompared += ts.names.length;
  }
  report.bigFiles = bigChecked; report.bigChunks = chunksCompared;

  /* 2. Every profile, on a sample of mid-sized files. */
  let profileCases = 0;
  const mids = files.filter((f) => f.size >= 1024 * 1024 && f.size < 8 * 1024 * 1024);
  for (const f of mids.filter((_, i) => i % Math.max(1, Math.floor(mids.length / 6)) === 0).slice(0, 6)) {
    const full = path.join(folder, f.path);
    const bytes = readFileSync(full);
    for (const profile of PROFILES) {
      const ts = tsCuts(bytes, profile);
      const native = engine(["cuts", full, profile.id]);
      if (JSON.stringify(native.bounds) !== JSON.stringify(ts.bounds) || JSON.stringify(native.chunks) !== JSON.stringify(ts.names)) {
        fail(`${f.path} with ${profile.id}: cuts differ`);
      }
      profileCases += 1;
    }
  }
  report.profileCases = profileCases;

  /* 3. The same folder stored by each. */
  const work = path.join(scratch, path.basename(folder).replace(/\W+/g, "-"));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const tsObjects = path.join(work, "ts", "objects");
  const nativeObjects = path.join(work, "native", "objects");
  const tsStore = new ObjectStore(tsObjects);
  const repository = { objects: tsStore };
  let started = performance.now();
  const tsStored = [];
  for (const f of files) tsStored.push(await storeFile(repository, path.join(folder, f.path), f.size));
  await tsStore.flush();
  report.tsStoreMs = Math.round(performance.now() - started);
  started = performance.now();
  const native = engine(["store", nativeObjects, folder], JSON.stringify(files));
  report.engineStoreMs = Math.round(performance.now() - started);
  let sameFiles = 0;
  const names = new Set();
  native.files.forEach((n, i) => {
    const t = tsStored[i];
    if (n.error) return fail(`${n.path}: engine could not store (${n.error})`);
    if (n.sha256 !== t.sha256 || JSON.stringify(n.chunks) !== JSON.stringify(t.chunks)) return fail(`${n.path}: stored differently`);
    sameFiles += 1;
    for (const c of n.chunks) names.add(c);
  });
  report.sameFiles = sameFiles;
  report.objects = names.size;
  /* Each reads the other's store. */
  const list = [...names];
  const nativeReadsTs = engine(["check", tsObjects], JSON.stringify(list));
  if (nativeReadsTs.bad.length) fail(`engine could not read ${nativeReadsTs.bad.length} objects from the TypeScript store: ${JSON.stringify(nativeReadsTs.bad.slice(0, 3))}`);
  const tsReader = new ObjectStore(nativeObjects);
  let tsReadBad = 0;
  for (const name of list) {
    try { if (sha(await tsReader.get(name)) !== name) tsReadBad += 1; } catch { tsReadBad += 1; }
  }
  await tsReader.release();
  if (tsReadBad) fail(`TypeScript could not read ${tsReadBad} objects from the engine's store`);
  report.crossRead = { engineReadTs: nativeReadsTs.checked - nativeReadsTs.bad.length, tsReadEngine: list.length - tsReadBad };

  /* 4. Deltas across the two implementations. */
  if (proto) {
    let seed = files.length * 7919 + 17;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const candidates = files.filter((f) => f.size > 4096 && f.size < 4 * 1024 * 1024);
    let deltaCases = 0;
    for (let k = 0; k < 20 && candidates.length; k++) {
      const f = candidates[Math.floor(rand() * candidates.length)];
      const base = readFileSync(path.join(folder, f.path));
      const at = Math.floor(rand() * base.length);
      const kind = k % 4;
      const target = kind === 0 ? Buffer.concat([base.subarray(0, at), Buffer.from("inserted bytes " + k), base.subarray(at)])
        : kind === 1 ? Buffer.concat([base.subarray(0, at), base.subarray(Math.min(base.length, at + 1 + Math.floor(rand() * 3000)))])
        : kind === 2 ? (() => { const c = Buffer.from(base); for (let j = 0; j < 50; j++) c[Math.floor(rand() * c.length)] ^= 0x5a; return c; })()
        : Buffer.concat([base.subarray(at), base.subarray(0, at)]);
      const bp = path.join(work, "base.bin"), tp = path.join(work, "target.bin"), dp = path.join(work, "delta.bin"), op = path.join(work, "out.bin");
      writeFileSync(bp, base); writeFileSync(tp, target);
      /* Engine makes, prototype applies. */
      engine(["delta-make", dp, tp, bp]);
      const fromEngine = proto.applyDelta([base], readFileSync(dp));
      if (!fromEngine.equals(target)) fail(`${f.path} edit ${kind}: prototype could not apply the engine's delta`);
      /* Prototype makes, engine applies. */
      writeFileSync(dp, proto.makeDelta([base], target));
      const applied = engine(["delta-apply", op, dp, bp]);
      if (applied.sha256 !== sha(target)) fail(`${f.path} edit ${kind}: engine could not apply the prototype's delta`);
      deltaCases += 1;
    }
    report.deltaCases = deltaCases;
  }
  report.failures = failures;
  console.log(JSON.stringify(report));
}
process.exit(failures ? 1 : 0);
