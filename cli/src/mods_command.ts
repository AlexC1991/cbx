/**
 * cbx mods — mod repositories for games.
 *
 * A game's developer sets one up (`cbx mods create`) and gets an address and
 * a public key to build into the game; modders publish to it with their own
 * CodeRook accounts (`cbx mods publish`), and nothing they send is listed
 * until it passes the repository's checks and a malware scan. The game's own
 * client reads the signed catalogue and downloads; that side is a protocol,
 * described in the docs, not something this command does.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { loadToken } from "./config.js";
import { accent, bold, dim, green, red } from "./colour.js";
import type { Parsed } from "./registry.js";
import { listFiles, writeZip } from "./zip_writer.js";

const ROOT = "/v1/modrepo";

function modsOrigin(): string {
  return (process.env.CODEROOK_MODS_URL ?? "https://mods.coderook.com").replace(/\/+$/, "");
}

const flag = (parsed: Parsed, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
};
const has = (parsed: Parsed, ...names: string[]) => names.some((name) => parsed.flags.has(name));

type Answer<T> = { status: number; body: T & { error?: string; message?: string } };

async function call<T = Record<string, unknown>>(
  route: string,
  method = "GET",
  body?: unknown,
  raw?: Uint8Array,
  auth = true,
): Promise<Answer<T>> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "CodeRook-CLI/0.1" };
  if (auth) {
    const token = await loadToken();
    if (!token) throw new Error("Not signed in. Run: cbx sign-in");
    headers.authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "application/octet-stream";
  const response = await fetch(`${modsOrigin()}${route}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text.slice(0, 200) }; }
  return { status: response.status, body: parsed as T & { error?: string; message?: string } };
}

function fail(answer: Answer<unknown>, doing: string): number {
  if (answer.status === 401) {
    console.error(red(`${doing}: not allowed. Sign in with cbx sign-in, and check you own this repository.`));
  } else {
    console.error(red(`${doing}: ${answer.body.message ?? answer.body.error ?? `failed (${answer.status})`}`));
  }
  return 1;
}

const list = (text: string | undefined) =>
  text === undefined ? undefined : text.split(",").map((one) => one.trim()).filter(Boolean).map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`));

/** Rules named on the command line, for create and settings. */
function settingsFrom(parsed: Parsed): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const allowed = list(flag(parsed, "allow"));
  const blocked = list(flag(parsed, "block"));
  const nested = list(flag(parsed, "nested"));
  if (allowed) settings.allowed = allowed;
  if (blocked) settings.blocked = blocked;
  if (nested) settings.nested = nested;
  const manifest = flag(parsed, "manifest");
  if (manifest !== undefined) settings.manifest = manifest === "none" ? null : manifest;
  const fields = flag(parsed, "fields");
  if (fields !== undefined) settings.manifestFields = fields.split(",").map((f) => f.trim()).filter(Boolean);
  for (const [name, key] of [["max-files", "maxFiles"], ["max-ratio", "maxRatio"], ["max-parts", "maxParts"]] as const) {
    const value = flag(parsed, name);
    if (value !== undefined) settings[key] = Number(value);
  }
  const maxPart = flag(parsed, "max-part");
  if (maxPart !== undefined) settings.maxPartBytes = parseSize(maxPart);
  const uploads = flag(parsed, "uploads");
  if (uploads !== undefined) settings.uploads = uploads;
  return settings;
}

function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(text.trim());
  if (!match) return Number.NaN;
  const unit = (match[2] ?? "b").toLowerCase();
  const factor = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.round(Number(match[1]) * factor);
}

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

type RepoView = {
  repo: string;
  name: string;
  about: string;
  owner: string;
  base: string;
  publicKey: string;
  rules: {
    allowed: string[]; blocked: string[]; nested: string[]; manifest: string | null; manifestFields: string[];
    maxFiles: number; maxRatio: number; maxPartBytes: number; maxParts: number; uploads: string;
  };
};

function printRepo(view: RepoView): void {
  console.log(`${bold(view.name)}  ${dim(view.repo)}`);
  if (view.about) console.log(dim(view.about));
  console.log(`Address     ${accent(view.base)}`);
  console.log(`Public key  ${view.publicKey}`);
  console.log(`Uploads     ${view.rules.uploads === "anyone" ? "any CodeRook account" : "the owner only"}`);
  console.log(`Allowed     ${view.rules.allowed.join(" ") || "(nothing)"}`);
  if (view.rules.nested.length) console.log(`Opened too  ${view.rules.nested.join(" ")} (files inside may have no extension)`);
  console.log(`Manifest    ${view.rules.manifest ? `${view.rules.manifest}, matching ${view.rules.manifestFields.join(", ")}` : "none"}`);
  console.log(`Limits      ${view.rules.maxFiles.toLocaleString()} files, ${bytes(view.rules.maxPartBytes)} a part, ${view.rules.maxParts} parts, unpacked ≤ ${view.rules.maxRatio}× the zip`);
  console.log(dim(`Never allowed: ${view.rules.blocked.join(" ")}`));
}

/* ------------------------------------------------------------------ subcommands */

async function create(parsed: Parsed): Promise<number> {
  const slug = parsed.positional[1];
  const name = flag(parsed, "name");
  if (!slug || !name) {
    console.error(red('Usage: cbx mods create <repo> --name "Game name" [--allow .png,.json] [--nested .pak] [--manifest mod.json] [--uploads anyone|owner]'));
    return 1;
  }
  const answer = await call<RepoView>(ROOT, "POST", { repo: slug, name, about: flag(parsed, "about"), settings: settingsFrom(parsed) });
  if (answer.status !== 201) return fail(answer, "Creating the repository");
  console.log(green(`Created ${answer.body.repo}.`));
  printRepo(answer.body);
  console.log(
    dim("\nBuild the public key into your game to check the catalogue's signature, and register your\n") +
      dim("game's build secret with: ") + accent(`cbx mods builds ${answer.body.repo} --register <file>`),
  );
  return 0;
}

async function repos(): Promise<number> {
  const answer = await call<{ repos: RepoView[] }>(`${ROOT}/mine`);
  if (answer.status !== 200) return fail(answer, "Listing your repositories");
  if (!answer.body.repos.length) {
    console.log(dim("You have no mod repositories. Create one with: ") + accent('cbx mods create <repo> --name "Game"'));
    return 0;
  }
  for (const view of answer.body.repos) console.log(`${accent(view.repo.padEnd(24))} ${view.name}  ${dim(view.base)}`);
  return 0;
}

async function info(parsed: Parsed): Promise<number> {
  const slug = parsed.positional[1];
  if (!slug) { console.error(red("Usage: cbx mods info <repo>")); return 1; }
  const answer = await call<RepoView>(`${ROOT}/${encodeURIComponent(slug)}/info`, "GET", undefined, undefined, false);
  if (answer.status !== 200) return fail(answer, `Reading ${slug}`);
  printRepo(answer.body);
  return 0;
}

async function settings(parsed: Parsed): Promise<number> {
  const slug = parsed.positional[1];
  if (!slug) { console.error(red("Usage: cbx mods settings <repo> [--allow …] [--uploads anyone|owner] …")); return 1; }
  const changes = settingsFrom(parsed);
  const name = flag(parsed, "name");
  const about = flag(parsed, "about");
  const body: Record<string, unknown> = {};
  if (Object.keys(changes).length) body.settings = changes;
  if (name !== undefined) body.name = name;
  if (about !== undefined) body.about = about;
  if (has(parsed, "disable")) body.disabled = true;
  if (has(parsed, "enable")) body.disabled = false;
  const route = `${ROOT}/${encodeURIComponent(slug)}/admin/settings`;
  const answer = Object.keys(body).length ? await call<RepoView>(route, "PUT", body) : await call<RepoView>(route);
  if (answer.status !== 200) return fail(answer, `Settings for ${slug}`);
  if (Object.keys(body).length) console.log(green("Saved."));
  printRepo(answer.body);
  return 0;
}

async function builds(parsed: Parsed): Promise<number> {
  const slug = parsed.positional[1];
  if (!slug) { console.error(red("Usage: cbx mods builds <repo> [--register <file> | --new | --off <id>]")); return 1; }
  const base = `${ROOT}/${encodeURIComponent(slug)}/admin/builds`;
  const off = flag(parsed, "off");
  if (off) {
    const answer = await call(`${base}/${encodeURIComponent(off)}`, "DELETE");
    if (answer.status !== 200) return fail(answer, `Turning off ${off}`);
    console.log(green(`Build ${off} is off: its signatures are refused from now on.`));
    return 0;
  }
  const register = flag(parsed, "register");
  const expires = flag(parsed, "expires");
  if (register || has(parsed, "new")) {
    let body: Record<string, unknown> = {};
    if (register) {
      /* The secret is read from a file and sent straight to the service; it is never printed or passed on a command line. */
      const secret = (await readFile(register, "utf8")).trim().toLowerCase();
      const hexSecret = /^[0-9a-f]{64}$/.test(secret) ? secret : Buffer.from(await readFile(register)).length === 32 ? Buffer.from(await readFile(register)).toString("hex") : "";
      if (!hexSecret) {
        console.error(red("The file must hold the 32-byte build secret, raw or as 64 hex characters."));
        return 1;
      }
      body = { secret: hexSecret };
    }
    if (expires) body.expires = expires;
    const answer = await call<{ build: string; secret?: string }>(base, "POST", body);
    if (answer.status !== 201) return fail(answer, "Registering the build");
    console.log(green(`Build ${answer.body.build} registered.`));
    if (answer.body.secret) {
      console.log(bold("Secret (shown once — compile it into this build and keep it out of any repository):"));
      console.log(answer.body.secret);
    }
    return 0;
  }
  const answer = await call<{ builds: Array<{ build: string; expires: string | null; disabled: boolean; created: string }> }>(base);
  if (answer.status !== 200) return fail(answer, `Builds of ${slug}`);
  if (!answer.body.builds.length) console.log(dim("No builds registered yet."));
  for (const b of answer.body.builds) {
    console.log(`${b.disabled ? dim(b.build) : accent(b.build)}  ${b.disabled ? red("off") : green("on ")}  ${dim(`since ${b.created.slice(0, 10)}${b.expires ? `, until ${b.expires.slice(0, 10)}` : ""}`)}`);
  }
  return 0;
}

type ModView = {
  mod: string;
  entry: { name: string; folder: string; version?: string; parts: Array<{ id: string; name?: string }> };
  author: string;
  hidden: boolean;
  parts: Array<{
    part: string;
    live: { size: number; sha256: string; files: number; since: string } | null;
    check: { state: string; problems?: string[]; infected?: Array<{ path: string; signature: string }> };
  }>;
};

function printMod(mod: ModView): void {
  console.log(`${bold(mod.entry.name)}  ${dim(mod.mod)}${mod.entry.version ? dim(`  v${mod.entry.version}`) : ""}${mod.hidden ? red("  hidden") : ""}`);
  for (const part of mod.parts) {
    const state = part.check.state;
    const colour = state === "live" ? green : state === "rejected" || state === "error" ? red : accent;
    const live = part.live ? dim(`  live: ${bytes(part.live.size)}, ${part.live.files.toLocaleString()} files`) : dim("  not listed");
    console.log(`  ${part.part.padEnd(16)} ${colour(state)}${live}`);
    for (const problem of part.check.problems ?? []) console.log(`    ${red("·")} ${problem}`);
    for (const found of part.check.infected ?? []) console.log(`    ${red("✗")} ${found.path}: ${found.signature}`);
  }
}

async function mine(parsed: Parsed): Promise<number> {
  const slug = flag(parsed, "repo") ?? parsed.positional[1];
  if (!slug) { console.error(red("Usage: cbx mods list <repo>")); return 1; }
  const route = has(parsed, "all") ? `${ROOT}/${encodeURIComponent(slug)}/admin/mods` : `${ROOT}/${encodeURIComponent(slug)}/my/mods`;
  const answer = await call<{ mods: ModView[] }>(route);
  if (answer.status !== 200) return fail(answer, `Mods in ${slug}`);
  if (!answer.body.mods.length) console.log(dim("No mods yet. Publish one with: ") + accent(`cbx mods publish <folder> --repo ${slug}`));
  for (const mod of answer.body.mods) printMod(mod);
  return 0;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readChunk(file: string, start: number, length: number): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start, end: start + length - 1 })) parts.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

async function publish(parsed: Parsed): Promise<number> {
  const target = parsed.positional[1];
  const slug = flag(parsed, "repo");
  if (!target || !slug) {
    console.error(red("Usage: cbx mods publish <folder|zip> --repo <repo> [--part <id>] [--id <mod>] [--name <text>] [--version <v>]"));
    return 1;
  }
  const source = path.resolve(target);
  if (!existsSync(source)) { console.error(red(`${target} does not exist.`)); return 1; }
  const base = `${ROOT}/${encodeURIComponent(slug)}`;
  const rules = await call<RepoView>(`${base}/info`, "GET", undefined, undefined, false);
  if (rules.status !== 200) return fail(rules, `Reading ${slug}`);
  const manifestName = rules.body.rules.manifest;

  /* The mod's identity: flags first, then the manifest in the folder, then the folder's name. */
  const isZip = (await stat(source)).isFile();
  let manifest: Record<string, unknown> = {};
  if (!isZip && manifestName && existsSync(path.join(source, manifestName))) {
    try { manifest = JSON.parse(await readFile(path.join(source, manifestName), "utf8")); } catch {
      console.error(red(`${manifestName} in that folder is not valid JSON.`));
      return 1;
    }
  }
  const folderName = path.basename(source).replace(/\.zip$/i, "");
  const id = (flag(parsed, "id") ?? (manifest.id as string | undefined) ?? folderName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")).toLowerCase();
  const name = flag(parsed, "name") ?? (manifest.name as string | undefined) ?? folderName;
  const folder = flag(parsed, "folder") ?? (manifest.folder as string | undefined) ?? folderName.replace(/[^A-Za-z0-9 ._-]+/g, "-");
  const version = flag(parsed, "version") ?? (manifest.version as string | undefined);
  const partId = (flag(parsed, "part") ?? "main").toLowerCase();

  /* Keep the parts the mod already declares, and add this one. */
  const existing = await call<ModView>(`${base}/my/mods/${encodeURIComponent(id)}`);
  const parts = existing.status === 200 ? [...existing.body.entry.parts] : [];
  if (!parts.some((p) => p.id === partId)) parts.push({ id: partId, name: flag(parsed, "part-name") ?? partId });
  const entry: Record<string, unknown> = {
    id, name, folder, parts,
    ...(version ? { version } : {}),
    ...(flag(parsed, "about") ? { about: flag(parsed, "about") } : existing.status === 200 && (existing.body.entry as { about?: string }).about ? { about: (existing.body.entry as { about?: string }).about } : {}),
    ...(flag(parsed, "notice") ? { notice: flag(parsed, "notice") } : {}),
  };
  const saved = await call(`${base}/my/mods`, "POST", entry);
  if (saved.status !== 200 && saved.status !== 201) return fail(saved, "Saving the mod's entry");

  /* A folder is zipped here, with the manifest written to match the entry; a zip is sent as it is. */
  let zipPath = source;
  let scratch: string | null = null;
  try {
    if (!isZip) {
      scratch = await mkdtemp(path.join(os.tmpdir(), "cbx-mod-"));
      zipPath = path.join(scratch, `${id}-${partId}.zip`);
      const files = await listFiles(source, (relative) => relative === ".git" || relative === ".coderook" || relative.endsWith(".DS_Store"));
      const extra = manifestName
        ? [{ path: manifestName, bytes: new TextEncoder().encode(JSON.stringify({ ...manifest, id, name, folder, ...(version ? { version } : {}) }, null, 2) + "\n") }]
        : [];
      process.stdout.write(dim(`Zipping ${files.length.toLocaleString()} files… `));
      const zipped = await writeZip(source, files, zipPath, extra);
      console.log(dim(bytes(zipped.bytes)));
    }
    const size = (await stat(zipPath)).size;
    if (size > rules.body.rules.maxPartBytes) {
      console.error(red(`The part is ${bytes(size)}; ${slug} takes up to ${bytes(rules.body.rules.maxPartBytes)} a part. Split it with --part.`));
      return 1;
    }
    const sha256 = await sha256File(zipPath);
    const begun = await call<{ upload: string; chunkBytes: number; chunks: number }>(`${base}/my/mods/${encodeURIComponent(id)}/parts/${encodeURIComponent(partId)}`, "PUT", { size, sha256 });
    if (begun.status !== 201) return fail(begun, "Starting the upload");
    for (let n = 1; n <= begun.body.chunks; n += 1) {
      const start = (n - 1) * begun.body.chunkBytes;
      const chunk = await readChunk(zipPath, start, Math.min(begun.body.chunkBytes, size - start));
      let sent: Answer<unknown> | null = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          sent = await call(`${base}/my/mods/${encodeURIComponent(id)}/parts/${encodeURIComponent(partId)}/chunks/${n}?upload=${encodeURIComponent(begun.body.upload)}`, "PUT", undefined, chunk);
          if (sent.status === 200) break;
        } catch {
          /* tried again below */
        }
      }
      if (!sent || sent.status !== 200) return fail(sent ?? { status: 0, body: { message: "the connection kept failing" } }, `Sending chunk ${n}`);
      process.stdout.write(`\r${dim(`Sent ${n} of ${begun.body.chunks} (${bytes(Math.min(size, n * begun.body.chunkBytes))} of ${bytes(size)})`)}   `);
    }
    console.log("");
    const done = await call<{ check: string }>(`${base}/my/mods/${encodeURIComponent(id)}/parts/${encodeURIComponent(partId)}/complete`, "POST", { upload: begun.body.upload });
    if (done.status !== 202) return fail(done, "Finishing the upload");
    console.log(green(`Uploaded ${id}/${partId}.`) + dim(" It is listed once its checks pass."));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  if (has(parsed, "no-wait")) {
    console.log(dim("See how the checks went with: ") + accent(`cbx mods list ${slug}`));
    return 0;
  }
  process.stdout.write(dim("Checking (structure, file types, malware scan)… "));
  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const now = await call<ModView>(`${base}/my/mods/${encodeURIComponent(id)}`);
    const part = now.body.parts?.find((p) => p.part === partId);
    const state = part?.check.state ?? "queued";
    if (!["queued", "checking"].includes(state)) {
      console.log("");
      printMod(now.body);
      return state === "live" ? 0 : 1;
    }
    if (Date.now() - started > 30 * 60 * 1000) {
      console.log("");
      console.log(dim("Still checking after 30 minutes; it carries on without you. Look later with ") + accent(`cbx mods list ${slug}`));
      return 0;
    }
  }
}

async function remove(parsed: Parsed): Promise<number> {
  const id = parsed.positional[1];
  const slug = flag(parsed, "repo");
  if (!id || !slug) { console.error(red("Usage: cbx mods remove <mod> --repo <repo> [--yes]")); return 1; }
  if (!has(parsed, "yes", "y")) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await prompt.question(`This takes ${id} out of ${slug} and deletes its files. Type its id to confirm: `)).trim();
    prompt.close();
    if (typed !== id) { console.error(red("That did not match. Nothing was removed.")); return 1; }
  }
  const owner = has(parsed, "as-owner") ? "admin" : "my";
  const answer = await call(`${ROOT}/${encodeURIComponent(slug)}/${owner}/mods/${encodeURIComponent(id)}`, "DELETE");
  if (answer.status !== 200) return fail(answer, `Removing ${id}`);
  console.log(green(`Removed ${id}.`));
  return 0;
}

async function block(parsed: Parsed): Promise<number> {
  const account = parsed.positional[1];
  const slug = flag(parsed, "repo");
  if (!account || !slug) { console.error(red("Usage: cbx mods block <username> --repo <repo> [--take-down] | --undo")); return 1; }
  const verb = has(parsed, "undo") ? "unblock" : "block";
  const answer = await call<{ hidden: boolean }>(`${ROOT}/${encodeURIComponent(slug)}/admin/uploaders/${encodeURIComponent(account)}/${verb}`, "POST", { takeDown: has(parsed, "take-down") });
  if (answer.status !== 200) return fail(answer, `${verb === "block" ? "Blocking" : "Unblocking"} ${account}`);
  console.log(green(verb === "block" ? `${account} can no longer upload to ${slug}${answer.body.hidden ? ", and their mods are hidden" : ""}.` : `${account} can upload to ${slug} again.`));
  return 0;
}

async function reports(parsed: Parsed): Promise<number> {
  const slug = parsed.positional[1];
  if (!slug) { console.error(red("Usage: cbx mods reports <repo>")); return 1; }
  const answer = await call<{ reports: Array<{ modId: string; partId: string | null; reason: string; detail: string; created: string }> }>(`${ROOT}/${encodeURIComponent(slug)}/admin/reports`);
  if (answer.status !== 200) return fail(answer, `Reports for ${slug}`);
  if (!answer.body.reports.length) console.log(dim("No reports."));
  for (const r of answer.body.reports) {
    console.log(`${dim(r.created.slice(0, 16).replace("T", " "))}  ${accent(r.modId)}${r.partId ? dim(`/${r.partId}`) : ""}  ${bold(r.reason)}${r.detail ? `  ${r.detail}` : ""}`);
  }
  return 0;
}

async function deleteRepo(parsed: Parsed): Promise<number> {
  const slug = parsed.positional[1];
  if (!slug) { console.error(red("Usage: cbx mods delete <repo>")); return 1; }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const typed = has(parsed, "yes") ? slug : (await prompt.question(`This deletes ${slug}, every mod in it and every build registration, for good. Type ${slug} to confirm: `)).trim();
  prompt.close();
  if (typed !== slug) { console.error(red("That did not match. Nothing was deleted.")); return 1; }
  const answer = await call(`${ROOT}/${encodeURIComponent(slug)}`, "DELETE", { confirm: slug });
  if (answer.status !== 200) return fail(answer, `Deleting ${slug}`);
  console.log(green(`Deleted ${slug}.`));
  return 0;
}

export async function commandMods(parsed: Parsed): Promise<number> {
  const sub = parsed.positional[0];
  switch (sub) {
    case "create": return create(parsed);
    case "repos": return repos();
    case "info": return info(parsed);
    case "settings": return settings(parsed);
    case "builds": return builds(parsed);
    case "list": return mine(parsed);
    case "publish": return publish(parsed);
    case "remove": return remove(parsed);
    case "block": return block(parsed);
    case "reports": return reports(parsed);
    case "delete": return deleteRepo(parsed);
    default:
      console.error(red(sub ? `cbx mods has no "${sub}". ` : "") + "See: " + accent("cbx help mods"));
      return 1;
  }
}
