import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Python for every system from any system.
 *
 * PyInstaller only builds for the machine it runs on, so Python was the one
 * language `cbx build` could not take to Linux from Windows. The portable
 * route assembles the target's own CPython, its wheels and the program into
 * one archive instead. The real run — a program using requests, psutil, rich
 * and platform-only packages, built for five targets from Windows — is done by
 * hand; these pin the parts that make the archive right.
 */

const { tarEntry, renamedEntries, scriptOf, runtimeRequirements } = await import(
  "../dist/cli/src/portable_python.js"
);
const { planBuild } = await import("../dist/cli/src/build_command.js");

/** Every entry in a tar: its full path, type, mode and link target. */
function list(archive: Buffer) {
  const found: Array<{ name: string; type: string; mode: number; link: string }> = [];
  let at = 0;
  let pending = "";
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]!);
    const stored = parseInt(field(148, 8).trim(), 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    assert.equal(stored, copy.reduce((total, byte) => total + byte, 0), "header checksum");
    if (type === "x") {
      pending = archive.subarray(at + 512, at + 512 + size).toString("utf8").match(/path=(.*)\n/)![1]!;
    } else {
      const prefix = field(345, 155);
      found.push({
        name: pending || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)),
        type, mode: parseInt(field(100, 8).trim(), 8), link: field(157, 100),
      });
      pending = "";
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

test("entries keep their modes and links, and long paths survive", () => {
  const long = `top/${"deep/".repeat(40)}module.py`;
  const archive = Buffer.concat([
    tarEntry("top/run", Buffer.from("#!/bin/sh\n"), 0o755),
    tarEntry("top/python/bin/python3", Buffer.alloc(0), 0o777, "python3.12"),
    tarEntry(long, Buffer.from("x = 1\n"), 0o644),
    Buffer.alloc(1024),
  ]);
  assert.deepEqual(list(archive), [
    { name: "top/run", type: "0", mode: 0o755, link: "" },
    { name: "top/python/bin/python3", type: "2", mode: 0o777, link: "python3.12" },
    { name: long, type: "0", mode: 0o644, link: "" },
  ]);
});

test("the interpreter's archive is renamed under the build's folder, links untouched", () => {
  const runtime = Buffer.concat([
    tarEntry("python/bin/python3.12", Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0o755),
    tarEntry("python/bin/python3", Buffer.alloc(0), 0o777, "python3.12"),
    tarEntry(`python/lib/python3.12/${"site/".repeat(25)}x.py`, Buffer.from(""), 0o644),
    Buffer.alloc(1024),
  ]);
  const renamed = list(Buffer.concat([...renamedEntries(runtime, "app-linux-x64"), Buffer.alloc(1024)]));
  assert.equal(renamed[0]!.name, "app-linux-x64/python/bin/python3.12");
  assert.equal(renamed[0]!.mode, 0o755);
  assert.deepEqual(renamed[1], { name: "app-linux-x64/python/bin/python3", type: "2", mode: 0o777, link: "python3.12" });
  assert.ok(renamed[2]!.name.startsWith("app-linux-x64/python/lib/python3.12/site/"));
});

test("the script is found in a PyInstaller spec, and build tools are not shipped", () => {
  assert.equal(scriptOf("main.py"), "main.py");
  assert.equal(scriptOf("app.spec", "a = Analysis(\n    ['src\\\\app\\\\main.py'],\n    pathex=[])"), "src/app/main.py");
  assert.throws(() => scriptOf("app.spec", "nothing here"), /could not find the script/);
  assert.equal(runtimeRequirements("requests\npyinstaller==6.10\nPyInstaller-hooks-contrib\nrich\n"), "requests\nrich\n");
});

test("Python builds every target from any machine that has uv or Python", () => {
  const project = { folder: path.join(tmpdir(), "p"), preset: "python", name: "app", entry: "main.py", config: {} };
  const all = ["windows-x64", "linux-x64", "linux-arm64", "macos-x64", "macos-arm64"];
  for (const host of [{ os: "windows", arch: "x64" }, { os: "linux", arch: "x64" }, { os: "macos", arch: "arm64" }]) {
    const plan = planBuild(project, host, { python: true }, all) as Array<{ ok: boolean; steps?: object[] }>;
    assert.ok(plan.every((one) => one.ok && one.steps!.some((step) => "portablePython" in step)), host.os);
  }
  const without = planBuild(project, { os: "windows", arch: "x64" }, {}, ["linux-x64"]) as Array<{ ok: boolean; why: string }>;
  assert.match(without[0]!.why, /needs uv, or Python with pip/);
});

test("a PyInstaller project keeps PyInstaller at home and goes portable elsewhere", () => {
  const project = { folder: path.join(tmpdir(), "p"), preset: "pyinstaller", name: "app", entry: "main.py", config: {} };
  const plan = planBuild(project, { os: "windows", arch: "x64" }, { pyinstaller: true, uv: true }, ["windows-x64", "linux-x64", "macos-arm64"]) as Array<{ how: string }>;
  assert.equal(plan[0]!.how, "pyinstaller");
  assert.match(plan[1]!.how, /portable CPython/);
  assert.match(plan[2]!.how, /portable CPython/);
});
