import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Which machine can build what, decided without building anything.
 *
 * `cbx build` plans every target before running a command, and the plan is a
 * pure function of the project, the host and the tools found on it — so the
 * answers for a Mac, a Linux box and a Windows PC are all tested here, from
 * whichever one runs the suite. The real builds are run by hand: Go, Bun,
 * Deno, .NET and Rust each produced Windows, Linux and both macOS binaries
 * from one Windows machine, checked by their headers.
 */

const { planBuild, parseTargets, describeProject, wslPath, fileFromTar } = await import(
  "../dist/cli/src/build_command.js"
);

type Planned = { target: string; ok: boolean; route?: string; why?: string; how?: string };
const windows = { os: "windows", arch: "x64" };
const linux = { os: "linux", arch: "x64" };
const mac = { os: "macos", arch: "arm64" };

const project = (preset: string, extra: Record<string, unknown> = {}) => ({
  folder: path.join(tmpdir(), "p"),
  preset,
  name: "app",
  entry: preset === "pyinstaller" ? "main.py" : preset === "go" ? "." : "index.ts",
  config: {},
  ...extra,
});
const routes = (plan: Planned[]) => Object.fromEntries(plan.map((one) => [one.target, one.ok ? one.route : "no"]));

test("targets are read the way people write them", () => {
  assert.deepEqual(parseTargets("win,linux,mac"), ["windows-x64", "linux-x64", "macos-arm64"]);
  assert.deepEqual(parseTargets("win-arm64 darwin-x64 linux-aarch64"), ["windows-arm64", "macos-x64", "linux-arm64"]);
  assert.deepEqual(parseTargets("all"), ["windows-x64", "linux-x64", "macos-x64", "macos-arm64"]);
  assert.throws(() => parseTargets("solaris"), /"solaris" is not a target/);
});

test("Go, Deno and .NET build every target from any machine", () => {
  const all = parseTargets("all");
  for (const host of [windows, linux, mac]) {
    for (const preset of ["go", "deno", "dotnet"]) {
      const plan = planBuild(project(preset), host, { go: true, deno: true, dotnet: true }, all) as Planned[];
      assert.ok(plan.every((one) => one.ok), `${preset} on ${host.os}: ${JSON.stringify(routes(plan))}`);
    }
  }
});

test("Go sets GOOS and GOARCH and turns cgo off", () => {
  const [step] = (planBuild(project("go"), windows, { go: true }, ["macos-arm64"]) as Array<{ steps: Array<{ env: Record<string, string> }> }>)[0]!.steps;
  assert.deepEqual(step!.env, { GOOS: "darwin", GOARCH: "arm64", CGO_ENABLED: "0" });
});

test("Bun fetches another system's runtime itself, and cannot do Windows on Arm", () => {
  const plan = planBuild(project("bun"), windows, { bun: true }, ["windows-x64", "linux-x64", "windows-arm64"]) as Array<Planned & { steps?: object[] }>;
  assert.equal(plan[0]!.steps!.some((step) => "bunRuntime" in step), false, "native needs no download");
  assert.equal(plan[1]!.steps!.some((step) => "bunRuntime" in step), true);
  assert.equal(plan[2]!.ok, false);
});

test("a missing toolchain says what to install", () => {
  const [one] = planBuild(project("go"), linux, {}, ["linux-x64"]) as Planned[];
  assert.equal(one!.ok, false);
  assert.match(one!.why!, /needs Go/);
});

test("Electron: macOS only on a Mac, Windows and Linux through Docker elsewhere", () => {
  const targets = ["windows-x64", "linux-x64", "macos-arm64"];
  assert.deepEqual(routes(planBuild(project("electron"), windows, { docker: true }, targets)), {
    "windows-x64": "native", "linux-x64": "docker", "macos-arm64": "no",
  });
  assert.deepEqual(routes(planBuild(project("electron"), linux, { docker: true }, targets)), {
    "windows-x64": "docker", "linux-x64": "native", "macos-arm64": "no",
  });
  assert.deepEqual(routes(planBuild(project("electron"), linux, { wine: true }, targets)), {
    "windows-x64": "cross", "linux-x64": "native", "macos-arm64": "no",
  });
  assert.deepEqual(routes(planBuild(project("electron"), mac, { docker: true }, targets)), {
    "windows-x64": "docker", "linux-x64": "docker", "macos-arm64": "native",
  });
  const [macFromWindows] = planBuild(project("electron"), windows, {}, ["macos-arm64"]) as Planned[];
  assert.match(macFromWindows!.why!, /only macOS has/);
  const [linuxNoDocker] = planBuild(project("electron"), windows, {}, ["linux-x64"]) as Planned[];
  assert.match(linuxNoDocker!.why!, /needs Docker running/);
});

test("PyInstaller builds its own system, and Linux through Docker or WSL", () => {
  const targets = ["windows-x64", "linux-x64", "macos-arm64"];
  assert.deepEqual(routes(planBuild(project("pyinstaller"), windows, { pyinstaller: true, docker: true }, targets)), {
    "windows-x64": "native", "linux-x64": "docker", "macos-arm64": "no",
  });
  assert.deepEqual(routes(planBuild(project("pyinstaller"), windows, { pyinstaller: true, wslPython: true }, targets)), {
    "windows-x64": "native", "linux-x64": "wsl", "macos-arm64": "no",
  });
  assert.deepEqual(routes(planBuild(project("pyinstaller"), linux, { pyinstaller: true, docker: true }, targets)), {
    "windows-x64": "no", "linux-x64": "native", "macos-arm64": "no",
  });
});

test("Rust: native, then zig, then cross in Docker, then a plain refusal", () => {
  const targets = ["windows-x64", "linux-x64", "macos-arm64"];
  assert.deepEqual(routes(planBuild(project("rust"), windows, { cargo: true, zigbuild: true }, targets)), {
    "windows-x64": "native", "linux-x64": "cross", "macos-arm64": "cross",
  });
  assert.deepEqual(routes(planBuild(project("rust"), linux, { cargo: true, cross: true, docker: true }, targets)), {
    "windows-x64": "docker", "linux-x64": "native", "macos-arm64": "no",
  });
  assert.deepEqual(routes(planBuild(project("rust"), mac, { cargo: true }, ["macos-x64", "macos-arm64", "linux-x64"])), {
    "macos-x64": "cross", "macos-arm64": "native", "linux-x64": "no",
  });
  const viaZig = (planBuild(project("rust"), linux, { cargo: true, zigbuild: true }, ["windows-x64"]) as Array<{ how: string }>)[0]!;
  assert.match(viaZig.how, /x86_64-pc-windows-gnu/, "Windows from elsewhere is the GNU ABI");
});

test("a WinForms app is Windows only", () => {
  const plan = planBuild(project("dotnet", { windowsOnly: true }), windows, { dotnet: true }, ["windows-x64", "linux-x64"]) as Planned[];
  assert.deepEqual(routes(plan), { "windows-x64": "native", "linux-x64": "no" });
});

test("a custom command gets the target filled in, and may run in a container", () => {
  const custom = project("custom", { config: { command: "make dist T={target} OUT={out}", docker: { "linux-x64": "gcc:14" } } });
  const plan = planBuild(custom, windows, { docker: true }, ["windows-x64", "linux-x64"]) as Array<Planned & { steps: Array<Record<string, unknown>> }>;
  assert.match(String(plan[0]!.steps[0]!.shell), /make dist T=windows-x64 OUT=\.coderook.build.windows-x64/);
  assert.equal(plan[1]!.route, "docker");
  assert.ok((plan[1]!.steps[0]!.args as string[]).includes("gcc:14"));
});

test("the toolchain is recognised from the files present", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "cbx-build-detect-"));
  writeFileSync(path.join(folder, "go.mod"), "module example.com/tools/widget\n\ngo 1.22\n");
  const found = await describeProject(folder);
  assert.equal(found.preset, "go");
  assert.equal(found.name, "widget");

  const electron = mkdtempSync(path.join(tmpdir(), "cbx-build-detect-"));
  writeFileSync(path.join(electron, "package.json"), JSON.stringify({ name: "@acme/desk", devDependencies: { "electron-builder": "^25" } }));
  const desk = await describeProject(electron);
  assert.equal(desk.preset, "electron");
  assert.equal(desk.name, "desk");

  const configured = mkdtempSync(path.join(tmpdir(), "cbx-build-detect-"));
  writeFileSync(path.join(configured, "coderook.build.json"), JSON.stringify({ preset: "custom", command: "make", name: "x" }));
  assert.equal((await describeProject(configured)).preset, "custom");
});

test("helpers: WSL paths and reading one file out of a tar", () => {
  assert.equal(wslPath("A:\\Github\\My App"), "/mnt/a/Github/My App");
  const header = Buffer.alloc(512);
  header.write("package/bin/bun", 0);
  header.write("0000000005\0", 124);
  const tar = Buffer.concat([header, Buffer.from("hello"), Buffer.alloc(507), Buffer.alloc(1024)]);
  assert.equal(fileFromTar(tar, "package/bin/bun")?.toString(), "hello");
  assert.equal(fileFromTar(tar, "package/bin/other"), null);
  void gzipSync;
});
