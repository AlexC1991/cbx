/**
 * A Python program built for another system, without that system.
 *
 * PyInstaller freezes a program with the interpreter it runs under, so it
 * only ever builds for the machine it is on — which left Python as the one
 * language `cbx build` could not take to Linux from Windows. This assembles
 * the same result from parts instead:
 *
 * - the target system's own CPython, from python-build-standalone (the
 *   relocatable builds uv and others use), checked against its published
 *   SHA-256;
 * - the program's dependencies as the target system's wheels, resolved by
 *   uv for that platform — environment markers included, which pip with
 *   `--platform` gets wrong because it evaluates them for this machine;
 * - the program's own files, and a launcher.
 *
 * Out comes `<name>-<target>.tar.gz`: one folder holding `python/`, `lib/`,
 * `app/` and the launcher, with every program in it marked executable. The
 * interpreter's archive is never unpacked here — its symlinks would not
 * survive Windows — its entries are carried across with their paths renamed.
 *
 * The limit is a package that publishes no wheel for the target: there is no
 * compiler for another system here, and uv says so by name.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gunzipSync, gzipSync } from "node:zlib";

import { excludes, parseRules, UNCOUNTED_DIRECTORIES } from "../../cbx/src/core/rules.js";
import { readRules } from "../../cbx/src/core/worktree.js";

export type PyTarget = "windows-x64" | "windows-arm64" | "linux-x64" | "linux-arm64" | "macos-x64" | "macos-arm64";

/** python-build-standalone's name for each system. */
export const PYTHON_TRIPLE: Record<PyTarget, string> = {
  "windows-x64": "x86_64-pc-windows-msvc",
  "windows-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "macos-x64": "x86_64-apple-darwin",
  "macos-arm64": "aarch64-apple-darwin",
};

/**
 * uv's name for the platform wheels are chosen for. Linux asks for glibc 2.28
 * (Debian 10, Ubuntu 20.04, RHEL 8 and later), which is where most projects'
 * wheels are built now; older wheels still qualify.
 */
export const UV_PLATFORM: Record<PyTarget, string> = {
  "windows-x64": "x86_64-pc-windows-msvc",
  "windows-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-manylinux_2_28",
  "linux-arm64": "aarch64-manylinux_2_28",
  "macos-x64": "x86_64-apple-darwin",
  "macos-arm64": "aarch64-apple-darwin",
};

/* ------------------------------------------------------------------ tar */

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function checksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
}

/** Where a path goes in a ustar header: name alone, or prefix and name. */
function splitName(full: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(full) <= 100) return { prefix: "", name: full };
  for (let at = full.indexOf("/"); at !== -1; at = full.indexOf("/", at + 1)) {
    const prefix = full.slice(0, at);
    const name = full.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { prefix, name };
  }
  return null;
}

/** A pax header carrying a path too long for ustar. */
function paxFor(full: string): Buffer {
  let record = ` path=${full}\n`;
  let length = Buffer.byteLength(record);
  /* The record counts its own length digits. */
  while (Buffer.byteLength(`${length}${record}`) !== length) length = Buffer.byteLength(`${length}${record}`);
  const body = Buffer.from(`${length}${record}`);
  const header = Buffer.alloc(512);
  header.write("PaxHeader", 0);
  header.write(octal(0o644, 8), 100, "latin1");
  header.write(octal(0, 8), 108, "latin1");
  header.write(octal(0, 8), 116, "latin1");
  header.write(octal(body.length, 12), 124, "latin1");
  header.write(octal(0, 12), 136, "latin1");
  header.write("x", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  checksum(header);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function setName(header: Buffer, full: string): Buffer[] {
  header.fill(0, 0, 100);
  header.fill(0, 345, 500);
  const split = splitName(full);
  if (split) {
    header.write(split.name, 0, 100, "utf8");
    header.write(split.prefix, 345, 155, "utf8");
    return [];
  }
  header.write(full.slice(-99), 0, 100, "utf8");
  return [paxFor(full)];
}

/** One file, or a symlink, as tar bytes. */
export function tarEntry(full: string, body: Buffer, mode: number, link?: string): Buffer {
  const header = Buffer.alloc(512);
  const before = setName(header, full);
  header.write(octal(mode, 8), 100, "latin1");
  header.write(octal(0, 8), 108, "latin1");
  header.write(octal(0, 8), 116, "latin1");
  header.write(octal(link ? 0 : body.length, 12), 124, "latin1");
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, "latin1");
  header.write(link ? "2" : "0", 156, "latin1");
  if (link) header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  checksum(header);
  const data = link ? [] : [body, Buffer.alloc((512 - (body.length % 512)) % 512)];
  return Buffer.concat([...before, header, ...data]);
}

/**
 * Every entry of a ustar archive, renamed under `top/`, header by header.
 * Bodies and link targets are untouched, so symlinks and modes survive.
 */
export function renamedEntries(archive: Buffer, top: string): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  while (at + 512 <= archive.length) {
    const header = Buffer.from(archive.subarray(at, at + 512));
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const span = 512 + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      throw new Error("the interpreter archive uses long-name headers this does not rewrite");
    }
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const before = setName(header, `${top}/${name}`);
    checksum(header);
    out.push(...before, header, Buffer.from(archive.subarray(at + 512, at + span)));
    at += span;
  }
  return out;
}

const isProgram = (body: Buffer) =>
  (body[0] === 0x7f && body.toString("latin1", 1, 4) === "ELF") ||
  body.toString("latin1", 0, 2) === "#!" ||
  (body.length >= 4 && [0xfeedfacf, 0xcafebabe, 0xbebafeca].includes(body.readUInt32LE(0)));

/* ------------------------------------------------------------- runtime */

function run(program: string, args: string[], options: { quiet?: boolean } = {}): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    let out = "";
    const child = spawn(program, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", (error) => done({ code: 1, out: error.message }));
    child.on("exit", (code) => done({ code: code ?? 1, out }));
  });
}

/** uv on PATH, or one installed into the cache with this machine's pip. */
async function findUv(cache: string): Promise<string> {
  if ((await run("uv", ["--version"], { quiet: true })).code === 0) return "uv";
  const local = path.join(cache, "uv", "bin", process.platform === "win32" ? "uv.exe" : "uv");
  if (existsSync(local)) return local;
  for (const python of ["python3", "python"]) {
    const installed = await run(python, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--target", path.join(cache, "uv"), "uv"], { quiet: true });
    if (installed.code === 0 && existsSync(local)) return local;
  }
  throw new Error("needs uv (https://docs.astral.sh/uv) or Python with pip to fetch it");
}

/** The target's CPython, downloaded once, checked against its published digest. */
async function pythonRuntime(cache: string, version: string, target: PyTarget, say: (text: string) => void): Promise<Buffer> {
  const folder = path.join(cache, "python");
  await mkdir(folder, { recursive: true });
  const wanted = new RegExp(`^cpython-${version.replace(".", "\\.")}\\.\\d+\\+\\d+-${PYTHON_TRIPLE[target]}-install_only\\.tar\\.gz$`);
  const cached = (await readdir(folder)).find((name) => wanted.test(name));
  if (cached) return readFile(path.join(folder, cached));

  const release = (await (await fetch("https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest", {
    headers: { accept: "application/vnd.github+json", "user-agent": "coderook-cli" },
  })).json()) as { assets?: Array<{ name: string; browser_download_url: string; digest?: string }> };
  const asset = (release.assets ?? []).find((one) => wanted.test(one.name));
  if (!asset) throw new Error(`no CPython ${version} build for ${target} in the latest python-build-standalone release`);
  if (!asset.digest?.startsWith("sha256:")) throw new Error("the release does not publish a digest for it");
  say(`Fetching ${asset.name}…`);
  const body = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
  if (createHash("sha256").update(body).digest("hex") !== asset.digest.slice("sha256:".length)) {
    throw new Error("the download does not match its published digest");
  }
  await writeFile(path.join(folder, asset.name), body);
  return body;
}

/* ------------------------------------------------------------- project */

/** The script PyInstaller would freeze: from a .spec's Analysis, or the file itself. */
export function scriptOf(entry: string, specText = ""): string {
  if (!entry.endsWith(".spec")) return entry;
  const found = specText.match(/Analysis\(\s*\[\s*(?:r)?['"]([^'"]+)['"]/);
  if (!found) throw new Error(`could not find the script in ${entry}; set "entry" to it`);
  /* A spec written on Windows escapes its backslashes: `src\\app\\main.py`. */
  return found[1]!.replace(/\\+/g, "/");
}

/** Requirements, minus the build tools that freeze rather than run the program. */
export function runtimeRequirements(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(pyinstaller|pyinstaller-hooks-contrib|nuitka|cx[-_]freeze)\b/i.test(line))
    .join("\n");
}

const SKIP = new Set([...UNCOUNTED_DIRECTORIES, "__pycache__", "build", "dist", "venv", ".venv", "env", "node_modules", ".mypy_cache", ".pytest_cache", ".tox"]);

/** The program's own files, as the project's ignore rules see them. */
async function appFiles(folder: string): Promise<string[]> {
  const rules = await readRules(folder);
  const layers = [{ base: "", rules: parseRules(`${rules.shared}\n${rules.local}`) }];
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(folder, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || excludes(rel, true, layers)) continue;
        await walk(rel);
      } else if (entry.isFile() && !excludes(rel, false, layers) && !/\.(pyc|pyo|spec)$/.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  await walk("");
  return found;
}

/* --------------------------------------------------------------- build */

export type PortableRequest = {
  folder: string;
  target: PyTarget;
  name: string;
  /** The script, or a PyInstaller .spec naming it. */
  entry: string;
  /** Major.minor; defaults to this machine's, or 3.12. */
  python?: string;
  /** Windows: start without a console window. */
  gui?: boolean;
  outFolder: string;
  cache: string;
  say?: (text: string) => void;
};

export async function buildPortablePython(request: PortableRequest): Promise<string> {
  const say = request.say ?? ((text: string) => console.log(text));
  const { folder, target } = request;
  const windows = target.startsWith("windows");
  const top = `${request.name}-${target}`;

  const hostVersion = (await run("python3", ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"], { quiet: true }));
  const hostVersionAlt = hostVersion.code === 0 ? hostVersion : await run("python", ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"], { quiet: true });
  const version = request.python ?? (hostVersionAlt.code === 0 ? hostVersionAlt.out.trim() : "3.12");

  const script = scriptOf(
    request.entry,
    request.entry.endsWith(".spec") ? await readFile(path.join(folder, request.entry), "utf8") : "",
  );
  if (!existsSync(path.join(folder, script))) throw new Error(`${script} is not in the project`);

  const runtime = gunzipSync(await pythonRuntime(request.cache, version, target, say));
  const uv = await findUv(request.cache);

  /* Dependencies, as the target's wheels. */
  const scratch = await mkdtemp(path.join(os.tmpdir(), "coderook-pybuild-"));
  try {
    const lib = path.join(scratch, "lib");
    await mkdir(lib);
    let requirements = "";
    if (existsSync(path.join(folder, "requirements.txt"))) {
      requirements = runtimeRequirements(await readFile(path.join(folder, "requirements.txt"), "utf8"));
    }
    if (requirements.trim()) {
      const file = path.join(scratch, "requirements.txt");
      await writeFile(file, requirements);
      say(`Resolving dependencies for ${target} (${UV_PLATFORM[target]}, Python ${version})…`);
      const installed = await run(uv, [
        "pip", "install", "--quiet", "--target", lib,
        "--python-platform", UV_PLATFORM[target], "--python-version", version,
        /* No building from source: it would build for this machine, not the target. */
        "--no-build", "-r", file,
      ]);
      if (installed.code !== 0) {
        throw new Error(
          /no wheels|--no-build|only-binary|has no wheel/i.test(installed.out)
            ? `a dependency publishes no ${target} wheel, and it cannot be compiled for ${target} here; build on that system instead`
            : "resolving the dependencies failed (above)",
        );
      }
    }

    const entries: Buffer[] = renamedEntries(runtime, top);
    const add = async (base: string, prefix: string, skipTop: Set<string> = new Set()) => {
      const walk = async (relative: string): Promise<void> => {
        for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
          const rel = relative ? `${relative}/${entry.name}` : entry.name;
          if (!relative && skipTop.has(entry.name)) continue;
          if (entry.isDirectory()) {
            if (entry.name === "__pycache__") continue;
            await walk(rel);
          } else if (entry.isFile()) {
            const body = await readFile(path.join(base, rel));
            entries.push(tarEntry(`${top}/${prefix}/${rel}`, body, isProgram(body) ? 0o755 : 0o644));
          }
        }
      };
      await walk("");
    };
    /* uv writes console scripts for this machine into bin/; they are not the target's. */
    await add(lib, "lib", new Set(["bin"]));
    for (const rel of await appFiles(folder)) {
      const body = await readFile(path.join(folder, rel));
      entries.push(tarEntry(`${top}/app/${rel}`, body, isProgram(body) ? 0o755 : 0o644));
    }

    if (windows) {
      const python = request.gui ? "pythonw.exe" : "python.exe";
      const launcher = [
        "@echo off",
        "setlocal",
        'set "HERE=%~dp0"',
        'set "PYTHONPATH=%HERE%lib;%HERE%app"',
        "set PYTHONNOUSERSITE=1",
        `${request.gui ? 'start "" ' : ""}"%HERE%python\\${python}" "%HERE%app\\${script.replace(/\//g, "\\")}" %*`,
        "",
      ].join("\r\n");
      entries.push(tarEntry(`${top}/${request.name}.cmd`, Buffer.from(launcher), 0o755));
    } else {
      const launcher = [
        "#!/bin/sh",
        "# Runs the program with the Python beside it. Made by cbx build.",
        'here="$(cd "$(dirname "$0")" && pwd -P)"',
        /* Exported, not prefixed: assignments before `exec` are not passed on by every sh. */
        'PYTHONPATH="$here/lib:$here/app${PYTHONPATH:+:$PYTHONPATH}"',
        "PYTHONNOUSERSITE=1",
        "export PYTHONPATH PYTHONNOUSERSITE",
        `exec "$here/python/bin/python3" "$here/app/${script}" "$@"`,
        "",
      ].join("\n");
      entries.push(tarEntry(`${top}/${request.name}`, Buffer.from(launcher), 0o755));
    }
    entries.push(Buffer.alloc(1024));

    await mkdir(request.outFolder, { recursive: true });
    const archive = path.join(request.outFolder, `${top}.tar.gz`);
    await writeFile(archive, gzipSync(Buffer.concat(entries), { level: 9 }));
    say(`Wrote ${path.basename(archive)} (${((await stat(archive)).size / 1024 ** 2).toFixed(1)} MB): unpack it and run ${windows ? `${request.name}.cmd` : `./${request.name}`}.`);
    return archive;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
