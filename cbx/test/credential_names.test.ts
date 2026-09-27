import assert from "node:assert/strict";
import test from "node:test";

import { isCredentialByName } from "../dist/core/worktree.js";

/**
 * Which files are credentials by their name alone.
 *
 * This exists because nothing tested it, and so `.env.example` — the file a
 * project is *supposed* to publish — was refused by the command line, with
 * advice to add it to .gitignore that would break the project for the next
 * person who cloned it.
 */

test("the real ones are caught", () => {
  for (const path of [
    ".env",
    ".env.local",
    ".env.production",
    "app/.env.staging",
    "id_rsa",
    "secrets/keys.json",
    "config/secrets/db.yml",
  ]) {
    assert.equal(isCredentialByName(path), true, path);
  }
});

test("templates are not credentials — they are meant to be committed", () => {
  for (const path of [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".env.defaults",
    "config/.env.example",
  ]) {
    assert.equal(isCredentialByName(path), false, path);
  }
});

test("ordinary files are left alone", () => {
  for (const path of ["README.md", "src/main.js", "environment.ts", "package.json"]) {
    assert.equal(isCredentialByName(path), false, path);
  }
});
