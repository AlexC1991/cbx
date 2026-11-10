import assert from "node:assert/strict";
import test from "node:test";

const { compareVersions, installKind, projectFolder } = await import("../dist/cli/src/update_command.js");

/*
  `cbx update` installs the newest cbx the way the running copy was installed.
  Reading the install wrongly runs the wrong npm command, so these pin both the
  version order and how each layout is recognised.
*/
test("release order: numbers compare as numbers, a pre-release is below its release", () => {
  assert.ok(compareVersions("0.44.0", "0.45.0") < 0);
  assert.ok(compareVersions("0.44.10", "0.44.9") > 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.2") > 0);
});

test("a global npm install on Windows is recognised whatever the case of the drive", () => {
  const root = "C:\\Users\\sam\\AppData\\Roaming\\npm\\node_modules";
  assert.equal(installKind("c:\\users\\sam\\AppData\\Roaming\\npm\\node_modules\\@coderook\\cli\\dist\\cli\\src\\cli.js", root, "win32"), "global");
});

test("a global install on Linux, npx, a project's packages and a source checkout", () => {
  const root = "/usr/lib/node_modules";
  assert.equal(installKind("/usr/lib/node_modules/@coderook/cli/dist/cli/src/cli.js", root, "linux"), "global");
  assert.equal(installKind("/home/sam/.npm/_npx/3f2a/node_modules/@coderook/cli/dist/cli/src/cli.js", root, "linux"), "npx");
  assert.equal(installKind("/home/sam/game/node_modules/@coderook/cli/dist/cli/src/cli.js", root, "linux"), "project");
  assert.equal(installKind("/home/sam/CodeBox/cli/dist/cli/src/cli.js", root, "linux"), "other");
  // npm could not say where its global packages live: never guess global.
  assert.equal(installKind("/usr/lib/node_modules/@coderook/cli/dist/cli/src/cli.js", null, "linux"), "project");
});

test("a project install updates in the folder that holds node_modules", () => {
  assert.equal(projectFolder("/home/sam/game/node_modules/@coderook/cli/dist/cli/src/cli.js"), "/home/sam/game");
});
