// Build cbx-engine for every platform the CLI ships to, and put the binaries where the CLI looks for them.
//
//   node cbx/engine/scripts/build-all.mjs [--target-dir <dir>]
//
// Writes cli/engine-bin/<platform>-<arch>/cbx-engine[.exe], named the way Node names
// process.platform and process.arch. No Docker: Linux and macOS are cross-built with
// cargo-zigbuild (Linux against glibc 2.17, so old distributions run it too).
// Windows on ARM needs Visual Studio's ARM64 tools; when they are missing it is skipped
// and the CLI uses its TypeScript path there.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const crate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(crate, "..", "..", "cli", "engine-bin");
const at = process.argv.indexOf("--target-dir");
const targetDir = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(crate, "target");
/* rustc asks for a macOS SDK when linking for Apple silicon; zig brings its own libraries, so an empty folder satisfies it. */
const sdk = mkdtempSync(path.join(os.tmpdir(), "cbx-engine-sdk-"));

const TARGETS = [
  { node: "win32-x64", rust: "x86_64-pc-windows-msvc", tool: "build", exe: true },
  { node: "win32-arm64", rust: "aarch64-pc-windows-msvc", tool: "build", exe: true, optional: true },
  { node: "linux-x64", rust: "x86_64-unknown-linux-gnu.2.17", tool: "zigbuild" },
  { node: "linux-arm64", rust: "aarch64-unknown-linux-gnu.2.17", tool: "zigbuild" },
  { node: "darwin-x64", rust: "x86_64-apple-darwin", tool: "zigbuild" },
  { node: "darwin-arm64", rust: "aarch64-apple-darwin", tool: "zigbuild" },
];

let failed = 0;
for (const target of TARGETS) {
  const run = spawnSync("cargo", [target.tool, "--release", "--target", target.rust], {
    cwd: crate,
    stdio: ["ignore", "inherit", "pipe"],
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, SDKROOT: sdk },
    encoding: "utf8",
  });
  const name = target.exe ? "cbx-engine.exe" : "cbx-engine";
  if (run.status !== 0) {
    console.log(`${target.node}: ${target.optional ? "skipped" : "FAILED"} (${run.stderr.trim().split("\n").pop()})`);
    if (!target.optional) failed += 1;
    continue;
  }
  const folder = target.rust.replace(/\.2\.17$/, "");
  mkdirSync(path.join(output, target.node), { recursive: true });
  copyFileSync(path.join(targetDir, folder, "release", name), path.join(output, target.node, name));
  console.log(`${target.node}: ok`);
}
process.exit(failed ? 1 : 0);
