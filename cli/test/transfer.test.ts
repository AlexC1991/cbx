/*
  Reading a repository address, without a network.

  Getting this wrong is quiet rather than loud: a URL that parses into the
  wrong owner still clones, still pushes, and produces a project named after
  something nobody asked for — or reads metadata from a repository that is not
  the one being transferred.
*/
import assert from "node:assert/strict";
import { test } from "node:test";

import { readForgeUrl } from "../src/forge_url.ts";

test("the three forges are told apart by host", () => {
  assert.equal(readForgeUrl("https://github.com/octocat/Hello-World").kind, "github");
  assert.equal(readForgeUrl("https://gitlab.com/group/project").kind, "gitlab");
  assert.equal(readForgeUrl("https://codeberg.org/owner/repo").kind, "gitea");
});

test("anything unrecognised is treated as Gitea rather than refused", () => {
  // Codeberg, Forgejo and every self-hosted Gitea share one API shape, so an
  // unknown host is far likelier to be one of those than to be nothing.
  const forge = readForgeUrl("https://git.example.com/team/thing.git");
  assert.equal(forge.kind, "gitea");
  assert.equal(forge.owner, "team");
  assert.equal(forge.repo, "thing");
});

test("a GitLab subgroup stays with the owner, not the project", () => {
  // Taking the first segment would address the top group and lose the project.
  const forge = readForgeUrl("https://gitlab.com/group/subgroup/project");
  assert.equal(forge.owner, "group/subgroup");
  assert.equal(forge.repo, "project");
});

test("an ssh address is understood", () => {
  const forge = readForgeUrl("git@github.com:owner/repo.git");
  assert.equal(forge.host, "github.com");
  assert.equal(forge.owner, "owner");
  assert.equal(forge.repo, "repo");
  // Cloning over https so a public repository needs no key.
  assert.equal(forge.clone, "https://github.com/owner/repo.git");
});

test("a bare host/owner/repo is accepted", () => {
  const forge = readForgeUrl("codeberg.org/owner/repo");
  assert.equal(forge.host, "codeberg.org");
  assert.equal(forge.repo, "repo");
});

test("the .git suffix is dropped from the project name", () => {
  assert.equal(readForgeUrl("https://github.com/owner/repo.git").repo, "repo");
  assert.equal(readForgeUrl("https://github.com/owner/repo").repo, "repo");
});

test("an address naming no repository is refused, not guessed at", () => {
  assert.throws(() => readForgeUrl("https://github.com/onlyowner"), /names no repository/);
  assert.throws(() => readForgeUrl("https://github.com"), /names no repository/);
});

test("each forge names the environment variable its token comes from", () => {
  // Never a flag: a token on the command line lands in shell history.
  assert.ok(readForgeUrl("https://github.com/a/b").tokenNames.includes("GITHUB_TOKEN"));
  assert.ok(readForgeUrl("https://gitlab.com/a/b").tokenNames.includes("GITLAB_TOKEN"));
  assert.ok(readForgeUrl("https://codeberg.org/a/b").tokenNames.includes("FORGE_TOKEN"));
});
