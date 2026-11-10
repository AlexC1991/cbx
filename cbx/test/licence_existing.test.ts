/**
 * A first save adds a licence only to a folder that has none, by any name.
 *
 * Found by saving a copy of Blender 4.5. Its licences sit in a folder called
 * `license`; on Windows that answers to "LICENSE", so the check opened a
 * directory and the whole save failed with EISDIR. On a folder whose licence
 * was called LICENSE.md or COPYING it would have succeeded, which was worse:
 * an MIT licence written beside somebody's GPL one.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { existingLicence, licenceNewProject } from "../dist/core/licences.js";

async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coderook-licence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a folder of licences is a licence, and the save does not fail on it", async (t) => {
  const root = await folder(t);
  await mkdir(path.join(root, "license"));
  await writeFile(path.join(root, "license", "license.md"), "GNU GENERAL PUBLIC LICENSE\n");
  assert.equal(await licenceNewProject(root, "ACCA Gaming Productions"), null);
  assert.deepEqual((await readdir(root)).sort(), ["license"]);
});

test("every usual name for a licence is respected", async (t) => {
  for (const name of [
    "LICENSE.md",
    "LICENCE.txt",
    "license",
    "COPYING",
    "COPYING.LIB",
    "LICENSE-APACHE",
    "UNLICENSE",
    "Licenses",
  ]) {
    const root = await folder(t);
    await writeFile(path.join(root, name), "Some licence\n");
    assert.equal(await existingLicence(root), name, name);
    assert.equal(await licenceNewProject(root, "ACCA Gaming Productions"), null, name);
  }
});

test("a folder with none gets the default, once", async (t) => {
  const root = await folder(t);
  await writeFile(path.join(root, "README.md"), "# A project\n");
  await writeFile(path.join(root, "licensing-notes.txt"), "not a licence file name\n");
  assert.equal(await existingLicence(root), null);
  const written = await licenceNewProject(root, "ACCA Gaming Productions");
  assert.ok(written, "a licence was written");
  assert.match(await readFile(path.join(root, "LICENSE"), "utf8"), /ACCA Gaming Productions/);
  assert.equal(await licenceNewProject(root, "ACCA Gaming Productions"), null, "not twice");
});

test("a folder that cannot be written to is saved without one, not failed", async () => {
  const missing = path.join(tmpdir(), "coderook-licence-does-not-exist", "deeper");
  assert.equal(await licenceNewProject(missing, "ACCA Gaming Productions"), null);
});
