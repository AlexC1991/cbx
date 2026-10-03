/**
 * `cbx build` — make a project's executables for Windows, Linux and macOS on
 * the machine you are sitting at.
 *
 * Actions could already run a command, on CodeRook's Linux sandbox or on a
 * machine that ran `cbx runner` — and each of those built for whatever it was.
 * Shipping one app for three systems meant three machines. Most toolchains do
 * not need that: Go, Bun, Deno and .NET produce every platform's binary from
 * any one of them, Rust does with zig, and Electron does Windows and Linux
 * through a container. What they lacked was something that knows which is
 * which on *this* machine and says plainly what it cannot do.
 *
 * So this plans first and builds second. Every target gets a route — native,
 * cross-compiled, in Docker, or in WSL — chosen from what is actually
 * installed, or a sentence saying why it cannot be built here and where it
 * can. Nothing is uploaded unless `--ship` is given; the output lands in
 * `.coderook/build/<target>/` — beside the folder's link, which CodeRook never
 * uploads and git is told to ignore. Not `dist/`: Electron apps commonly
 * package `dist/**`, and every installer would then carry the last ones.
 *
 * A project can describe itself in `coderook.build.json` at its root, which is
 * saved with the project like any other file. Without one, the toolchain is
 * worked out from the files that are there.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { Parsed } from "./registry.js";

const ESC = String.fromCharCode(27);
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (value: string) => (colour ? `${ESC}[${code}m${value}${ESC}[0m` : value);
const dim = paint("2");
const bold = paint("1");
const red = paint("31");
const green = paint("32");
const accent = paint("33");

/* ------------------------------------------------------------ targets */

export type OsName = "windows" | "linux" | "macos";
export type ArchName = "x64" | "arm64";
export type Target = `${OsName}-${ArchName}`;

export const ALL_TARGETS: Target[] = [
  "windows-x64", "windows-arm64", "linux-x64", "linux-arm64", "macos-x64", "macos-arm64",
];
export const DEFAULT_TARGETS: Target[] = ["windows-x64", "linux-x64", "macos-arm64"];

const ALIASES: Record<string, Target[]> = {
  all: ["windows-x64", "linux-x64", "macos-x64", "macos-arm64"],
  win: ["windows-x64"], windows: ["windows-x64"],
  linux: ["linux-x64"],
  mac: ["macos-arm64"], macos: ["macos-arm64"], darwin: ["macos-arm64"],
};

/** `win,linux,mac`, `windows-x64`, `all`: what was asked for, as targets. */
export function parseTargets(text: string): Target[] {
  const found: Target[] = [];
  for (const word of text.split(/[\s,]+/).map((one) => one.trim().toLowerCase()).filter(Boolean)) {
    const normal = word.replace(/^win-/, "windows-").replace(/^mac-|^darwin-/, "macos-").replace(/-amd64$/, "-x64").replace(/-aarch64$/, "-arm64");
    const named = ALIASES[normal] ?? (ALL_TARGETS.includes(normal as Target) ? [normal as Target] : null);
    if (!named) throw new Error(`"${word}" is not a target. Use ${ALL_TARGETS.join(", ")}, or win, linux, mac, all.`);
    for (const target of named) if (!found.includes(target)) found.push(target);
  }
  return found;
}

const osOf = (target: Target) => target.split("-")[0] as OsName;
const archOf = (target: Target) => target.split("-")[1] as ArchName;
const exe = (target: Target) => (osOf(target) === "windows" ? ".exe" : "");

export type Host = { os: OsName; arch: ArchName };

export function thisHost(): Host {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  return { os: platform, arch: process.arch === "arm64" ? "arm64" : "x64" };
}

/* -------------------------------------------------------------- tools */

export type ToolName =
  | "go" | "bun" | "deno" | "cargo" | "rustup" | "zigbuild" | "cross" | "dotnet"
  | "docker" | "wsl" | "wslPython" | "pyinstaller" | "wine" | "node";
export type Tools = Partial<Record<ToolName, boolean>>;

/** Whether a command answers within a few seconds, without a shell. */
function answers(program: string, args: string[], timeoutMs = 8000): Promise<boolean> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(program, args, { stdio: "ignore", windowsHide: true });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/** What this machine has, asked of each tool rather than guessed from PATH. */
export async function detectTools(host: Host = thisHost()): Promise<Tools> {
  const checks: Array<[ToolName, Promise<boolean>]> = [
    ["go", answers("go", ["version"])],
    ["bun", answers("bun", ["--version"])],
    ["deno", answers("deno", ["--version"])],
    ["cargo", answers("cargo", ["--version"])],
    ["rustup", answers("rustup", ["--version"])],
    ["zigbuild", answers("cargo", ["zigbuild", "--help"])],
    ["cross", answers("cross", ["--version"])],
    ["dotnet", answers("dotnet", ["--version"])],
    /* The daemon, not the client: a stopped Docker Desktop answers --version. */
    ["docker", answers("docker", ["info", "--format", "{{.ServerVersion}}"], 15000)],
    ["pyinstaller", answers("pyinstaller", ["--version"], 15000)],
    ["wine", host.os === "windows" ? Promise.resolve(false) : answers("wine", ["--version"])],
    ["node", answers(process.execPath, ["--version"])],
  ];
  if (host.os === "windows") {
    checks.push(["wsl", answers("wsl", ["-e", "true"], 20000)]);
    checks.push(["wslPython", answers("wsl", ["-e", "python3", "-m", "PyInstaller", "--version"], 30000)]);
  }
  const tools: Tools = {};
  await Promise.all(checks.map(async ([name, check]) => {
    tools[name] = await check;
  }));
  return tools;
}

/* ------------------------------------------------------------ project */

export type Preset = "go" | "bun" | "deno" | "rust" | "dotnet" | "electron" | "pyinstaller" | "custom";

export type BuildConfig = {
  preset?: Preset;
  /** The program's name, which every output file starts with. */
  name?: string;
  /** What to build: a Go package, a script, a .csproj, a .spec — per preset. */
  entry?: string;
  targets?: string[];
  /** Run before each target, natively (or in the container on a Docker route). */
  before?: string;
  /** Where outputs go; each target gets a folder of its own inside it. */
  out?: string;
  /** Extra arguments for the toolchain's build command. */
  args?: string[];
  /**
   * `custom`: the command, run once per target with {target}, {os}, {arch}
   * and {out} filled in. It decides how to cross-build; `docker` names an
   * image to run it in for a given target.
   */
  command?: string;
  docker?: Partial<Record<Target, string>>;
};

export type Project = {
  folder: string;
  preset: Preset | null;
  name: string;
  entry: string | null;
  /** .NET projects that only build for Windows (WinForms, WPF). */
  windowsOnly?: boolean;
  /** Electron: whether electron-builder is installed in this folder. */
  hasBuilder?: boolean;
  config: BuildConfig;
};

const CONFIG_FILE = "coderook.build.json";

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const safeName = (name: string) =>
  name.replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "app";

/** The preset, name and entry point, from the config and the files present. */
export async function describeProject(folder: string): Promise<Project> {
  const here = (file: string) => existsSync(path.join(folder, file));
  let config: BuildConfig = {};
  if (here(CONFIG_FILE)) {
    const raw = await readJson(path.join(folder, CONFIG_FILE));
    if (!raw) throw new Error(`${CONFIG_FILE} is not valid JSON.`);
    config = raw as BuildConfig;
  }
  const pkg = await readJson(path.join(folder, "package.json"));
  const entries = (await readdir(folder).catch(() => [] as string[]));
  const csproj = entries.find((file) => file.endsWith(".csproj"));
  const spec = entries.find((file) => file.endsWith(".spec"));
  const dependencies = { ...(pkg?.dependencies as object ?? {}), ...(pkg?.devDependencies as object ?? {}) } as Record<string, string>;

  let preset: Preset | null = config.preset ?? (config.command ? "custom" : null);
  if (!preset) {
    if (here("go.mod")) preset = "go";
    else if (here("Cargo.toml")) preset = "rust";
    else if (csproj) preset = "dotnet";
    else if (dependencies["electron-builder"] || dependencies["electron"]) preset = "electron";
    else if (here("deno.json") || here("deno.jsonc")) preset = "deno";
    else if (here("bun.lock") || here("bun.lockb") || here("bunfig.toml")) preset = "bun";
    else if (spec || (await readFile(path.join(folder, "requirements.txt"), "utf8").catch(() => "")).match(/pyinstaller/i)) preset = "pyinstaller";
  }

  let name = config.name ?? "";
  let entry = config.entry ?? null;
  let windowsOnly = false;
  if (preset === "go" && !name) {
    const module = (await readFile(path.join(folder, "go.mod"), "utf8").catch(() => "")).match(/^module\s+(\S+)/m)?.[1];
    name = module?.split("/").pop() ?? "";
    entry ??= ".";
  }
  if (preset === "rust" && !name) {
    const cargo = await readFile(path.join(folder, "Cargo.toml"), "utf8").catch(() => "");
    name = cargo.match(/\[package\][^[]*?\bname\s*=\s*"([^"]+)"/)?.[1] ?? "";
  }
  if (preset === "dotnet") {
    entry ??= csproj ?? null;
    if (entry) {
      const text = await readFile(path.join(folder, entry), "utf8").catch(() => "");
      windowsOnly = /<UseWindowsForms>\s*true|<UseWPF>\s*true|<TargetFrameworks?>[^<]*-windows/i.test(text);
      name ||= text.match(/<AssemblyName>([^<]+)</)?.[1] ?? path.basename(entry, ".csproj");
    }
  }
  if (preset === "bun" || preset === "deno") {
    const bin = pkg?.bin;
    entry ??=
      (typeof bin === "string" ? bin : bin && typeof bin === "object" ? String(Object.values(bin)[0]) : null) ??
      (typeof pkg?.module === "string" ? pkg.module : null) ??
      (typeof pkg?.main === "string" ? pkg.main : null) ??
      ["main.ts", "mod.ts", "index.ts", "src/main.ts", "src/index.ts", "index.js"].find(here) ??
      null;
  }
  if (preset === "pyinstaller") {
    entry ??= spec ?? ["main.py", "app.py", "__main__.py", "src/main.py"].find(here) ?? null;
  }
  if (!name && typeof pkg?.name === "string") name = pkg.name;
  /*
    An Electron app is usually compiled before it is packaged, and
    electron-builder packages whatever is there: without this the installer
    holds last week's build, or none. A `build` script that is itself
    electron-builder is the packaging, not the compiling, and is left alone.
  */
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  if (preset === "electron" && config.before === undefined && scripts.build && !/electron-builder/.test(scripts.build)) {
    config = { ...config, before: "npm run build" };
  }
  if (preset === "pyinstaller" && !name && entry?.endsWith(".spec")) name = path.basename(entry, ".spec");
  const hasBuilder = preset === "electron" ? existsSync(path.join(folder, "node_modules", "electron-builder", "cli.js")) : undefined;
  return {
    folder, preset, name: safeName(name || path.basename(folder)), entry, windowsOnly, config,
    ...(hasBuilder === undefined ? {} : { hasBuilder }),
  };
}

/* --------------------------------------------------------------- plan */

/** One command. `program` with `args`, or a shell line for custom commands. */
export type Exec =
  | { program: string; args: string[]; env?: Record<string, string> }
  | { shell: string; env?: Record<string, string> }
  | { copy: { from: string; to: string } }
  /* Bun's runtime for another system, fetched and checked here; see bunRuntime. */
  | { bunRuntime: { target: Target; to: string } };

/** Where fetched toolchain pieces are kept between builds. */
function cacheDirectory(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(base, "coderook", "build");
}

export type Planned =
  | { target: Target; ok: true; route: "native" | "cross" | "docker" | "wsl"; how: string; steps: Exec[]; out: string }
  | { target: Target; ok: false; why: string };

/** A command that runs inside a throwaway container with the project mounted. */
function inDocker(project: Project, image: string, inner: string, volumes: string[] = []): Exec {
  return {
    program: "docker",
    args: [
      "run", "--rm",
      "-v", `${project.folder}:/project`,
      ...volumes.flatMap((volume) => ["-v", volume]),
      "-w", "/project",
      image, "sh", "-lc", inner,
    ],
  };
}

/** A path inside WSL for a Windows path: `A:\x\y` is `/mnt/a/x/y`. */
export function wslPath(windowsPath: string): string {
  const match = windowsPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return windowsPath.replace(/\\/g, "/");
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`;
}

const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const GO_OS: Record<OsName, string> = { windows: "windows", linux: "linux", macos: "darwin" };
const GO_ARCH: Record<ArchName, string> = { x64: "amd64", arm64: "arm64" };
const DENO: Record<Target, string> = {
  "windows-x64": "x86_64-pc-windows-msvc", "windows-arm64": "",
  "linux-x64": "x86_64-unknown-linux-gnu", "linux-arm64": "aarch64-unknown-linux-gnu",
  "macos-x64": "x86_64-apple-darwin", "macos-arm64": "aarch64-apple-darwin",
};
const DOTNET: Record<Target, string> = {
  "windows-x64": "win-x64", "windows-arm64": "win-arm64", "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64", "macos-x64": "osx-x64", "macos-arm64": "osx-arm64",
};
const RUST: Record<Target, string> = {
  "windows-x64": "x86_64-pc-windows-msvc", "windows-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu", "linux-arm64": "aarch64-unknown-linux-gnu",
  "macos-x64": "x86_64-apple-darwin", "macos-arm64": "aarch64-apple-darwin",
};

const NEEDS = (os: OsName) =>
  `run cbx build --target ${os === "macos" ? "mac" : os} on a ${os === "macos" ? "Mac" : os === "windows" ? "Windows PC" : "Linux machine"}, or a cbx runner on one`;

/**
 * Every target, with how this machine would build it or why it cannot.
 *
 * Pure: the same project, host and tools always give the same plan, which is
 * what lets the choices be tested for machines this one is not.
 */
export function planBuild(project: Project, host: Host, tools: Tools, targets: Target[]): Planned[] {
  const outRoot = project.config.out ?? path.join(".coderook", "build");
  const extra = project.config.args ?? [];
  const before = project.config.before;
  return targets.map((target): Planned => {
    const out = path.join(outRoot, target);
    const outAbs = path.join(project.folder, out);
    const os_ = osOf(target);
    const arch = archOf(target);
    const native = host.os === os_ && host.arch === arch;
    const sameOs = host.os === os_;
    const file = `${project.name}-${target}${exe(target)}`;
    const pre: Exec[] = before ? [{ shell: before }] : [];
    const missing = (tool: string, why = "") =>
      ({ target, ok: false, why: `needs ${tool}${why}` }) as Planned;

    switch (project.preset) {
      case "go": {
        if (!tools.go) return missing("Go (https://go.dev/dl)");
        return {
          target, ok: true, route: native ? "native" : "cross", out,
          how: native ? "go build" : `go build for ${GO_OS[os_]}/${GO_ARCH[arch]}, cgo off`,
          steps: [...pre, {
            program: "go",
            args: ["build", ...extra, "-o", path.join(outAbs, file), project.entry ?? "."],
            env: { GOOS: GO_OS[os_], GOARCH: GO_ARCH[arch], CGO_ENABLED: "0" },
          }],
        };
      }
      case "bun": {
        if (!tools.bun) return missing("Bun (https://bun.sh)");
        if (target === "windows-arm64") return { target, ok: false, why: "Bun cannot compile for Windows on Arm" };
        if (!project.entry) return { target, ok: false, why: `no entry point; set "entry" in ${CONFIG_FILE}` };
        const bunOs = os_ === "macos" ? "darwin" : os_;
        /*
          Bun fetches another system's runtime itself, and on Windows 1.3 fails
          to unpack it ("Failed to extract executable"). Fetching it here, from
          the same npm package and checked against npm's own digest, and
          handing Bun the file works on every host.
        */
        const runtime = path.join(cacheDirectory(), "bun", target, `bun${exe(target)}`);
        return {
          target, ok: true, route: native ? "native" : "cross", out,
          how: `bun build --compile --target=bun-${bunOs}-${arch}`,
          steps: [
            ...pre,
            ...(native ? [] : [{ bunRuntime: { target, to: runtime } } as Exec]),
            {
              program: "bun",
              args: [
                "build", "--compile", `--target=bun-${bunOs}-${arch}`,
                ...(native ? [] : [`--compile-executable-path=${runtime}`]),
                ...extra, project.entry, "--outfile", path.join(outAbs, file),
              ],
            },
          ],
        };
      }
      case "deno": {
        if (!tools.deno) return missing("Deno (https://deno.com)");
        if (!DENO[target]) return { target, ok: false, why: "Deno cannot compile for Windows on Arm" };
        if (!project.entry) return { target, ok: false, why: `no entry point; set "entry" in ${CONFIG_FILE}` };
        return {
          target, ok: true, route: native ? "native" : "cross", out,
          how: `deno compile --target ${DENO[target]}`,
          steps: [...pre, {
            program: "deno",
            args: ["compile", ...extra, "--target", DENO[target], "--output", path.join(outAbs, file), project.entry],
          }],
        };
      }
      case "dotnet": {
        if (!tools.dotnet) return missing(".NET SDK (https://dot.net)");
        if (project.windowsOnly && os_ !== "windows") {
          return { target, ok: false, why: "a WinForms or WPF app runs only on Windows" };
        }
        return {
          target, ok: true, route: native ? "native" : "cross", out,
          how: `dotnet publish -r ${DOTNET[target]}, self-contained, single file`,
          steps: [...pre, {
            program: "dotnet",
            args: [
              "publish", ...(project.entry ? [project.entry] : []), "-c", "Release", "-r", DOTNET[target],
              "--self-contained", "true", "-p:PublishSingleFile=true", ...extra, "-o", outAbs,
            ],
          }],
        };
      }
      case "rust": {
        if (!tools.cargo) return missing("Rust (https://rustup.rs)");
        const triple = RUST[target];
        const built = (tripleUsed: string) => ({
          copy: {
            from: path.join(project.folder, "target", tripleUsed, "release", `${project.name}${exe(target)}`),
            to: path.join(outAbs, file),
          },
        });
        const addTarget = (tripleUsed: string): Exec[] =>
          tools.rustup ? [{ program: "rustup", args: ["target", "add", tripleUsed] }] : [];
        /*
          Plain cargo for this machine's own target, and for the other Mac
          architecture on a Mac, which Xcode links. Anything else needs a
          linker for the other system: zig, or a container.
        */
        if (native || (host.os === "macos" && os_ === "macos")) {
          return {
            target, ok: true, route: native ? "native" : "cross", out,
            how: `cargo build --target ${triple}`,
            steps: [...pre, ...addTarget(triple), { program: "cargo", args: ["build", "--release", "--target", triple, ...extra] }, built(triple)],
          };
        }
        const gnu = os_ === "windows" ? triple.replace("-msvc", "-gnu") : triple;
        if (tools.zigbuild && !(os_ === "windows" && arch === "arm64")) {
          return {
            target, ok: true, route: "cross", out,
            how: `cargo zigbuild --target ${gnu}${os_ === "macos" ? " (pure-Rust crates; system frameworks need a Mac)" : ""}`,
            steps: [...pre, ...addTarget(gnu), { program: "cargo", args: ["zigbuild", "--release", "--target", gnu, ...extra] }, built(gnu)],
          };
        }
        if (tools.cross && tools.docker && os_ !== "macos") {
          return {
            target, ok: true, route: "docker", out,
            how: `cross build --target ${gnu}`,
            steps: [...pre, { program: "cross", args: ["build", "--release", "--target", gnu, ...extra] }, built(gnu)],
          };
        }
        return {
          target, ok: false,
          why: os_ === "macos"
            ? `needs cargo-zigbuild (cargo install cargo-zigbuild, plus zig) to cross-compile, or ${NEEDS("macos")}`
            : "needs cargo-zigbuild (cargo install cargo-zigbuild, plus zig), or cross with Docker running",
        };
      }
      case "electron": {
        /* Only the container installs its own; this machine's must already be there. */
        const local = os_ === "macos" || sameOs || (os_ === "windows" && tools.wine);
        if (project.hasBuilder === false && local) {
          return { target, ok: false, why: "electron-builder is not installed here; run npm install first" };
        }
        const flag = os_ === "windows" ? "--win" : os_ === "macos" ? "--mac" : "--linux";
        const builder = ["electron-builder", flag, `--${arch}`, "--publish", "never", ...extra];
        const outputFlag = (dir: string) => `--config.directories.output=${dir}`;
        if (os_ === "macos") {
          if (host.os !== "macos") {
            return { target, ok: false, why: `macOS apps are packaged and signed with tools only macOS has; ${NEEDS("macos")}` };
          }
          return {
            target, ok: true, route: native ? "native" : "cross", out, how: `electron-builder ${flag} --${arch}`,
            steps: [...pre, { program: process.execPath, args: [path.join(project.folder, "node_modules", "electron-builder", "cli.js"), ...builder.slice(1), outputFlag(out)] }],
          };
        }
        const nativeOk = sameOs || (os_ === "windows" && host.os !== "windows" && tools.wine);
        if (nativeOk) {
          return {
            target, ok: true, route: sameOs ? (native ? "native" : "cross") : "cross", out,
            how: `electron-builder ${flag} --${arch}${!sameOs ? " with wine" : ""}`,
            steps: [...pre, { program: process.execPath, args: [path.join(project.folder, "node_modules", "electron-builder", "cli.js"), ...builder.slice(1), outputFlag(out)] }],
          };
        }
        if (!tools.docker) {
          return { target, ok: false, why: `needs Docker running (electronuserland/builder${os_ === "windows" ? ":wine" : ""}), or ${NEEDS(os_)}` };
        }
        const image = os_ === "windows" ? "electronuserland/builder:wine" : "electronuserland/builder";
        const inner = [
          "npm ci",
          before,
          `npx --no-install ${builder.join(" ")} ${outputFlag(out.replace(/\\/g, "/"))}`,
        ].filter(Boolean).join(" && ");
        return {
          target, ok: true, route: "docker", out, how: `electron-builder ${flag} --${arch} in ${image}`,
          steps: [inDocker(project, image, inner, [
            /* This machine's node_modules are for this machine; the container keeps its own. */
            `coderook-build-${project.name}-node-modules:/project/node_modules`,
            "coderook-build-electron-cache:/root/.cache/electron",
            "coderook-build-electron-builder-cache:/root/.cache/electron-builder",
          ])],
        };
      }
      case "pyinstaller": {
        if (!project.entry) return { target, ok: false, why: `no entry point; set "entry" in ${CONFIG_FILE}` };
        const work = path.join("build", "coderook", target);
        const flags = (dist: string, workDir: string, specDir: string) =>
          project.entry!.endsWith(".spec")
            ? ["--noconfirm", "--distpath", dist, "--workpath", workDir, ...extra, project.entry!]
            : ["--noconfirm", "--onefile", "--name", `${project.name}-${target}`, "--distpath", dist, "--workpath", workDir, "--specpath", specDir, ...extra, project.entry!];
        if (native) {
          if (!tools.pyinstaller) return missing("PyInstaller (pip install pyinstaller)");
          return {
            target, ok: true, route: "native", out, how: "pyinstaller",
            steps: [...pre, { program: "pyinstaller", args: flags(outAbs, path.join(project.folder, work), path.join(project.folder, "build", "coderook")) }],
          };
        }
        /* PyInstaller cannot cross-compile; Linux on x64 can still be reached from here. */
        if (target === "linux-x64" && host.arch === "x64") {
          const unix = (value: string) => value.replace(/\\/g, "/");
          const requirements = existsSync(path.join(project.folder, "requirements.txt")) ? "pip install -q -r requirements.txt && " : "";
          if (tools.docker) {
            const inner = `${before ? `${before} && ` : ""}pip install -q pyinstaller && ${requirements}pyinstaller ${flags(unix(out), unix(work), "build/coderook").map(sq).join(" ")}`;
            return {
              target, ok: true, route: "docker", out, how: "pyinstaller in python:3.12 (Debian)",
              steps: [inDocker(project, "python:3.12", inner, ["coderook-build-pip-cache:/root/.cache/pip"])],
            };
          }
          if (tools.wslPython) {
            const inner = `cd ${sq(wslPath(project.folder))} && ${before ? `${before} && ` : ""}python3 -m PyInstaller ${flags(unix(out), unix(work), "build/coderook").map(sq).join(" ")}`;
            return {
              target, ok: true, route: "wsl", out, how: "pyinstaller in WSL",
              steps: [{ program: "wsl", args: ["-e", "sh", "-lc", inner] }],
            };
          }
          return { target, ok: false, why: `PyInstaller builds only for the system it runs on; needs Docker running, or WSL with PyInstaller, or ${NEEDS("linux")}` };
        }
        return { target, ok: false, why: `PyInstaller builds only for the system it runs on; ${NEEDS(os_)}` };
      }
      case "custom": {
        if (!project.config.command) return { target, ok: false, why: `"custom" needs a "command" in ${CONFIG_FILE}` };
        const fill = (text: string, outPath: string) =>
          text.replace(/\{target\}/g, target).replace(/\{os\}/g, os_).replace(/\{arch\}/g, arch).replace(/\{out\}/g, outPath);
        const image = project.config.docker?.[target];
        if (image) {
          if (!tools.docker) return { target, ok: false, why: `needs Docker running for ${image}` };
          const unixOut = out.replace(/\\/g, "/");
          return {
            target, ok: true, route: "docker", out, how: `${project.config.command} in ${image}`,
            steps: [inDocker(project, image, [before, fill(project.config.command, unixOut)].filter(Boolean).join(" && "))],
          };
        }
        return {
          target, ok: true, route: native ? "native" : "cross", out, how: project.config.command,
          steps: [...pre, { shell: fill(project.config.command, out), env: { CODEROOK_TARGET: target, CODEROOK_OS: os_, CODEROOK_ARCH: arch, CODEROOK_OUT: out } }],
        };
      }
      default:
        return { target, ok: false, why: `no toolchain recognised here; set "preset" in ${CONFIG_FILE}` };
    }
  });
}

/* ---------------------------------------------------------------- run */

/** What a command prints, or null when it does not run. */
function output(program: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    let text = "";
    const child = spawn(program, args, { windowsHide: true });
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("error", () => done(null));
    child.on("exit", (code) => done(code === 0 ? text.trim() : null));
  });
}

/** The one file at `name` in a tar archive, read without unpacking the rest. */
export function fileFromTar(archive: Buffer, name: string): Buffer | null {
  let at = 0;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const entry = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (entry === name) return archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function fetchBunRuntime(target: Target, to: string): Promise<number> {
  const version = await output("bun", ["--version"]);
  if (!version) {
    console.error(red("Could not ask bun for its version."));
    return 1;
  }
  const marker = `${to}.version`;
  if (existsSync(to) && (await readFile(marker, "utf8").catch(() => "")) === version) return 0;
  const pkg = `bun-${osOf(target) === "macos" ? "darwin" : osOf(target)}-${archOf(target) === "arm64" ? "aarch64" : "x64"}`;
  console.log(dim(`Fetching Bun ${version}'s runtime for ${target} (@oven/${pkg})…`));
  try {
    const meta = (await (await fetch(`https://registry.npmjs.org/@oven/${pkg}/${version}`)).json()) as {
      dist?: { tarball?: string; integrity?: string };
    };
    if (!meta.dist?.tarball || !meta.dist.integrity?.startsWith("sha512-")) throw new Error("npm did not describe the package");
    const tarball = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
    const digest = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    if (digest !== meta.dist.integrity) throw new Error("the download does not match npm's digest");
    const binary = fileFromTar(gunzipSync(tarball), `package/bin/bun${exe(target)}`);
    if (!binary) throw new Error("the package holds no runtime");
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, binary, { mode: 0o755 });
    await writeFile(marker, version);
    return 0;
  } catch (error) {
    console.error(red(`Could not fetch Bun's runtime for ${target}: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
}

function run(step: Exec, cwd: string): Promise<number> {
  if ("bunRuntime" in step) return fetchBunRuntime(step.bunRuntime.target, step.bunRuntime.to);
  if ("copy" in step) {
    return (async () => {
      try {
        await mkdir(path.dirname(step.copy.to), { recursive: true });
        await copyFile(step.copy.from, step.copy.to);
        return 0;
      } catch (error) {
        console.error(red(`Could not find the built file: ${step.copy.from}`));
        console.error(dim(`  ${error instanceof Error ? error.message : String(error)}`));
        return 1;
      }
    })();
  }
  return new Promise((done) => {
    const env = { ...process.env, ...(step.env ?? {}) };
    const child =
      "shell" in step
        ? spawn(step.shell, { cwd, env, stdio: "inherit", shell: true })
        /*
          Never through a shell: it joins arguments without quoting them, so a
          path with a space in it splits. Electron's builder is started by its
          own script under this Node for the same reason, rather than by npx,
          which on Windows is a .cmd that only a shell can run.
        */
        : spawn(step.program, step.args, { cwd, env, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(red(`${"shell" in step ? step.shell : step.program}: ${error.message}`));
      done(1);
    });
    child.on("exit", (code) => done(code ?? 1));
  });
}

/** The files a target produced, at the top of its folder. */
export async function outputsOf(folder: string): Promise<Array<{ file: string; size: number }>> {
  const found: Array<{ file: string; size: number }> = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    /* electron-builder's own bookkeeping; CodeRook's update feed writes its own. */
    if (/\.(yml|yaml|blockmap|pdb|dbg)$/i.test(entry.name)) continue;
    const full = path.join(folder, entry.name);
    found.push({ file: full, size: (await stat(full)).size });
  }
  return found;
}

const human = (bytes: number) =>
  bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/* ------------------------------------------------------------ command */

export async function commandBuild(parsed: Parsed): Promise<number> {
  const folder = path.resolve(parsed.positional[0] === "init" ? (parsed.positional[1] ?? process.cwd()) : (parsed.positional[0] ?? process.cwd()));
  const flag = (name: string) => parsed.flags.get(name);

  if (parsed.positional[0] === "init") return initConfig(folder);

  let project: Project;
  try {
    project = await describeProject(folder);
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  const presetFlag = flag("preset");
  if (typeof presetFlag === "string") project = { ...project, preset: presetFlag as Preset };
  if (!project.preset) {
    console.error(red("No toolchain recognised in this folder."));
    console.error(dim(`  Looked for go.mod, Cargo.toml, a .csproj, electron-builder, deno.json, a Bun lockfile and a PyInstaller .spec.`));
    console.error(dim(`  Say which with ${accent("--preset <go|bun|deno|rust|dotnet|electron|pyinstaller>")}, or describe it in ${CONFIG_FILE} (${accent("cbx build init")}).`));
    return 1;
  }

  let targets: Target[];
  try {
    const asked = flag("target") ?? flag("t");
    targets = typeof asked === "string"
      ? parseTargets(asked)
      : project.config.targets?.length
        ? parseTargets(project.config.targets.join(","))
        : DEFAULT_TARGETS;
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  const host = thisHost();
  console.log(dim(`Checking what this ${host.os} ${host.arch} machine can build with…`));
  const tools = await detectTools(host);
  const plan = planBuild(project, host, tools, targets);

  console.log(`${bold(project.name)} ${dim(`(${project.preset})`)}`);
  const width = Math.max(...plan.map((one) => one.target.length));
  for (const one of plan) {
    console.log(
      one.ok
        ? `  ${accent(one.target.padEnd(width))}  ${one.route.padEnd(6)}  ${dim(one.how)}`
        : `  ${red(one.target.padEnd(width))}  ${"no".padEnd(6)}  ${dim(one.why)}`,
    );
  }
  if (parsed.flags.has("plan") || parsed.flags.has("dry-run") || parsed.flags.has("n")) {
    console.log(dim("Nothing was built."));
    return 0;
  }

  /* Kept out of git as the link beside it is, without touching .gitignore. */
  if (!project.config.out) {
    await mkdir(path.join(folder, ".coderook"), { recursive: true });
    if (!existsSync(path.join(folder, ".coderook", ".gitignore"))) {
      await writeFile(path.join(folder, ".coderook", ".gitignore"), "*\n");
    }
  }
  const results: Array<{ target: Target; ok: boolean; files: Array<{ file: string; size: number }> }> = [];
  for (const one of plan) {
    if (!one.ok) continue;
    console.log(`\n${bold(`Building ${one.target}`)} ${dim(`— ${one.how}`)}`);
    const outAbs = path.join(folder, one.out);
    await rm(outAbs, { recursive: true, force: true });
    await mkdir(outAbs, { recursive: true });
    let code = 0;
    for (const step of one.steps) {
      code = await run(step, folder);
      if (code !== 0) break;
    }
    const files = code === 0 ? await outputsOf(outAbs) : [];
    results.push({ target: one.target, ok: code === 0 && files.length > 0, files });
    if (code === 0 && !files.length) console.error(red(`${one.target}: the build finished but left nothing in ${one.out}.`));
  }

  console.log(`\n${bold("Built")}`);
  for (const one of plan) {
    const result = results.find((each) => each.target === one.target);
    if (!one.ok) {
      console.log(`  ${red("✗")} ${one.target.padEnd(width)}  ${dim(`not here: ${one.why}`)}`);
    } else if (!result?.ok) {
      console.log(`  ${red("✗")} ${one.target.padEnd(width)}  ${red("failed")}`);
    } else {
      for (const [at, output] of result.files.entries()) {
        console.log(
          `  ${at ? " " : green("✓")} ${(at ? "" : one.target).padEnd(width)}  ${path.relative(folder, output.file)} ${dim(human(output.size))}`,
        );
      }
    }
  }

  const failed = results.filter((one) => !one.ok).length;
  if (parsed.flags.has("ship") && results.some((one) => one.ok)) {
    if (failed) {
      console.error(red("\nNothing was attached: a build failed, and a release missing a platform is worse than a late one."));
      return 1;
    }
    const { commandAttach } = await import("./attach_command.js");
    for (const result of results) {
      for (const output of result.files) {
        const base = path.basename(output.file);
        const named = base.includes(result.target) || /win|linux|mac|darwin|osx/i.test(base)
          ? base
          : `${path.parse(base).name}-${result.target}${path.parse(base).ext}`;
        const code = await commandAttach({
          positional: [output.file],
          flags: new Map([["name", named]]),
        } as Parsed);
        if (code !== 0) return code;
      }
    }
  }
  if (failed) return 1;
  return results.length ? 0 : 1;
}

async function initConfig(folder: string): Promise<number> {
  const file = path.join(folder, CONFIG_FILE);
  if (existsSync(file)) {
    console.error(red(`${CONFIG_FILE} already exists here.`));
    return 1;
  }
  const project = await describeProject(folder);
  const config: BuildConfig = {
    preset: project.preset ?? "custom",
    name: project.name,
    ...(project.entry ? { entry: project.entry } : {}),
    targets: DEFAULT_TARGETS,
    ...(project.preset ? {} : { command: "echo describe how to build {target} into {out}" }),
  };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote ${CONFIG_FILE} ${dim(`(${config.preset}${project.preset ? ", recognised from the files here" : ", fill in the command"})`)}.`);
  console.log(dim(`  ${accent("cbx build --plan")} shows what this machine can build from it.`));
  return 0;
}
