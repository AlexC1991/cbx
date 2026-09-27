/**
 * The local history through the real binary, in a folder with no account.
 *
 * The engine's own tests cover what a restore may and may not overwrite. This
 * covers what only the command line decides: that `log`, `status`, `diff` and
 * `switch` mean the local history in a folder that has one, that flags reach
 * the commands with their values, and that a refusal is a sentence and an
 * exit code rather than a stack trace.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("dist/cli/src/cli.js");
const home = mkdtempSync(path.join(tmpdir(), "coderook-local-home-"));
const ESC = String.fromCharCode(27);
const plain = (text: string) => text.split(ESC).map((part, at) => (at ? part.replace(/^\[[0-9;]*m/, "") : part)).join("");

function cbx(folder: string, ...args: string[]): { code: number; out: string } {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: folder,
    encoding: "utf8",
    env: { ...process.env, CODEROOK_TOKEN: "", CODEROOK_CONFIG_DIR: home, CBX_AUTHOR: "tester" },
  });
  return { code: run.status ?? -1, out: plain(`${run.stdout}${run.stderr}`) };
}

function write(folder: string, name: string, text: string): void {
  const full = path.join(folder, name);
  writeFileSync(full, text);
  const past = new Date(Date.now() - 60_000);
  utimesSync(full, past, past);
}

test("init, save, status, diff, log, switch and restore, offline", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "cbx-local-cli-"));
  try {
    write(folder, "game.txt", "speed = 1\n");

    let run = cbx(folder, "init");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Started a history/);
    assert.equal(cbx(folder, "init").code, 1);

    run = cbx(folder, "save", "-m", "First pass");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Saved [0-9a-f]{10} on main: First pass/);

    run = cbx(folder, "save", "-m", "again");
    assert.match(run.out, /Nothing has changed/);
    assert.equal(cbx(folder, "save").code, 1);

    write(folder, "game.txt", "speed = 2\n");
    run = cbx(folder, "status");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /changed game\.txt/);

    run = cbx(folder, "diff");
    assert.match(run.out, /- speed = 1/);
    assert.match(run.out, /\+ speed = 2/);

    run = cbx(folder, "switch", "-c", "faster");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Started faster/);
    assert.equal(cbx(folder, "save", "-m", "Faster").code, 0);

    run = cbx(folder, "log");
    assert.match(run.out, /Faster[\s\S]*First pass/);

    run = cbx(folder, "switch", "main");
    assert.equal(run.code, 0, run.out);
    assert.equal(readFileSync(path.join(folder, "game.txt"), "utf8"), "speed = 1\n");

    run = cbx(folder, "diff", "main", "faster", "--name-only");
    assert.match(run.out, /~ game\.txt/);
    assert.doesNotMatch(run.out, /speed/);

    /* An unsaved edit stops a restore, is listed, and survives. */
    write(folder, "game.txt", "speed = 99\n");
    run = cbx(folder, "restore", "--from", "faster");
    assert.equal(run.code, 1);
    assert.match(run.out, /unsaved changes to 1 file/);
    assert.equal(readFileSync(path.join(folder, "game.txt"), "utf8"), "speed = 99\n");

    run = cbx(folder, "restore", "game.txt", "--from", "faster", "--force");
    assert.equal(run.code, 0, run.out);
    assert.equal(readFileSync(path.join(folder, "game.txt"), "utf8"), "speed = 2\n");
    assert.match(run.out, /line has not moved/);

    run = cbx(folder, "switch");
    assert.match(run.out, /\* main/);
    assert.match(run.out, /faster/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("without a history, log and switch keep their account meanings", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "cbx-no-history-"));
  try {
    /* `track` with no name prints the line, or says the folder is not linked. */
    const switched = cbx(folder, "switch");
    assert.doesNotMatch(switched.out, /No history here/);
    const saved = cbx(folder, "save", "-m", "x");
    assert.equal(saved.code, 1);
    assert.match(saved.out, /cbx init/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("merge through the binary: conflict, take a side, finish by saving", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "cbx-merge-cli-"));
  try {
    write(folder, "game.txt", "speed = 1\n");
    cbx(folder, "init");
    cbx(folder, "save", "-m", "start");
    cbx(folder, "switch", "-c", "feature");
    write(folder, "game.txt", "speed = 2\n");
    write(folder, "extra.txt", "only on feature\n");
    cbx(folder, "save", "-m", "feature");
    cbx(folder, "switch", "main");
    write(folder, "game.txt", "speed = 3\n");
    cbx(folder, "save", "-m", "main");

    let run = cbx(folder, "merge", "feature");
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /1 conflict/);
    assert.match(readFileSync(path.join(folder, "game.txt"), "utf8"), /<<<<<<< main/);
    assert.equal(readFileSync(path.join(folder, "extra.txt"), "utf8"), "only on feature\n");

    run = cbx(folder, "status");
    assert.match(run.out, /conflict game\.txt/);
    run = cbx(folder, "save");
    assert.equal(run.code, 1);
    assert.match(run.out, /conflict markers/);

    run = cbx(folder, "merge", "--theirs", "--path", "game.txt");
    assert.equal(run.code, 0, run.out);
    assert.equal(readFileSync(path.join(folder, "game.txt"), "utf8"), "speed = 2\n");
    run = cbx(folder, "save");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Merge feature into main/);
    run = cbx(folder, "merge", "feature");
    assert.match(run.out, /already part of this line/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
