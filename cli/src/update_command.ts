/**
 * `cbx update` — bring this copy of cbx itself up to the newest release.
 *
 * Not the folder: `cbx get` (and `cbx pull`) bring a project's files up to
 * date. This asks the npm registry for the newest @coderook/cli and installs it
 * the way this copy was installed, because the right command differs:
 *
 *   global npm install   npm install -g @coderook/cli@<newest>, run here
 *   npx                  nothing to install; npx fetches what it is told to
 *   a project's packages npm install @coderook/cli@<newest> in that project
 *   anything else        the command to run, printed rather than guessed at
 *
 * Every outward call has a deadline, so a registry or npm that never answers
 * ends in a message instead of a hang.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { VERSION } from "./version.js";

const PACKAGE = "@coderook/cli";
/** A release number and nothing else: it is put on an npm command line. */
const RELEASE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?$/;
const REGISTRY = "https://registry.npmjs.org/" + PACKAGE.replace("/", "%2F") + "/latest";

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint(2), accent = paint(33), red = paint(31), green = paint(32);

export type InstallKind = "global" | "npx" | "project" | "other";

/** Compares two release numbers (1.2.3, pre-release tags rank below the release). Negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre = ""] = v.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * How the running copy was installed, from where its files are.
 * `globalRoot` is `npm root -g` (null when npm could not say).
 */
export function installKind(script: string, globalRoot: string | null, platform: NodeJS.Platform = process.platform): InstallKind {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? s.toLowerCase() : s;
  };
  const here = norm(script);
  if (!here.includes("/node_modules/@coderook/cli/")) return "other";
  if (/\/_npx\//.test(here)) return "npx";
  if (globalRoot && here.startsWith(norm(globalRoot) + "/")) return "global";
  return "project";
}

/** The folder holding the node_modules this copy sits in (for a project install). */
export function projectFolder(script: string): string {
  const s = script.replace(/\\/g, "/");
  const at = s.lastIndexOf("/node_modules/@coderook/cli/");
  return at < 0 ? path.dirname(script) : s.slice(0, at);
}

async function newestRelease(): Promise<string> {
  const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !RELEASE.test(body.version)) throw new Error("the npm registry gave no usable version");
  return body.version;
}

/** Runs npm with a deadline; output goes to this terminal when `show` is set. */
function npm(args: string[], options: { show: boolean; cwd?: string; deadlineMs: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    /*
      npm is npm.cmd on Windows, which Node only starts through a shell, and a
      shell takes one command line rather than an argument list. Every word
      here is ours or a release number checked by RELEASE, so joining is safe.
    */
    const stdio: ("ignore" | "pipe" | "inherit")[] = options.show ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "ignore"];
    const child = process.platform === "win32"
      ? spawn(["npm", ...args].join(" "), { cwd: options.cwd, shell: true, stdio })
      : spawn("npm", args, { cwd: options.cwd, stdio });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, out }); }, options.deadlineMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: -2, out }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

export async function commandUpdate(flags: Map<string, unknown>): Promise<number> {
  const checkOnly = flags.has("check");
  let newest: string;
  try {
    newest = await newestRelease();
  } catch (error) {
    console.error(red("Could not find out the newest cbx: " + (error instanceof Error ? error.message : String(error)) + "."));
    console.error(dim("Check the connection and try again. Nothing was changed."));
    return 1;
  }
  const order = compareVersions(VERSION, newest);
  if (order >= 0) {
    console.log(green(`cbx ${VERSION} is the newest.`) + (order > 0 ? dim(` (the registry's newest is ${newest})`) : ""));
    return 0;
  }
  console.log(`cbx ${VERSION} is installed; ${accent(newest)} is out.`);

  let script = process.argv[1] ?? "";
  try { script = realpathSync(script); } catch { /* keep what we were given */ }
  const root = await npm(["root", "-g"], { show: false, deadlineMs: 20_000 });
  const kind = installKind(script, root.code === 0 ? root.out.trim() : null);
  const target = `${PACKAGE}@${newest}`;

  if (kind === "npx") {
    /* The package has three commands (cbx, coderook, git-remote-coderook), so npx must be told which: -p names the package. */
    console.log(`This copy runs through npx. Ask for the newest each time with ${accent(`npx -p ${PACKAGE}@latest cbx`)}.`);
    return 0;
  }
  if (kind === "other") {
    console.log(`This copy was not installed by npm, so install the newest with ${accent(`npm install -g ${target}`)}.`);
    return 0;
  }
  const folder = kind === "project" ? projectFolder(script) : undefined;
  const args = kind === "global" ? ["install", "-g", target] : ["install", target];
  if (checkOnly) {
    console.log(`Update with ${accent("cbx update")}, or ${accent("npm " + args.join(" "))}${folder ? dim(` in ${folder}`) : ""}.`);
    return 0;
  }
  console.log(dim(`Running npm ${args.join(" ")}${folder ? ` in ${folder}` : ""}…`));
  const result = await npm(args, { show: true, cwd: folder, deadlineMs: 5 * 60_000 });
  if (result.code !== 0) {
    console.error(red(result.code === -1 ? "npm did not finish within five minutes." : result.code === -2 ? "npm could not be started." : `npm stopped with code ${result.code}.`));
    if (kind === "global") console.error(dim("If it was refused for permissions, run the same command from a terminal that can install global packages."));
    console.error(dim(`Your current cbx ${VERSION} is untouched.`));
    return 1;
  }
  console.log(green(`cbx is now ${newest}.`) + dim(" Your folders, sign-in and settings are as they were."));
  return 0;
}
