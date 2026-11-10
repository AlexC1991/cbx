import assert from "node:assert/strict";
import test from "node:test";

import { detectStarters } from "../dist/cli/src/workspace_starter.js";

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

test("a Node package gets one check recipe running its check, build and test scripts, fastest first", () => {
  const [one, ...rest] = detectStarters(
    new Map([
      ["web/package.json", pkg({ test: "vitest run", build: "next build", check: "tsc --noEmit", dev: "next dev" })],
      ["web/package-lock.json", ""],
    ]),
  );
  assert.equal(rest.length, 0);
  assert.deepEqual(one, {
    recipe: "web-check",
    workflow: "Draft check · web",
    directory: "web",
    command: "npm ci && npm run check && npm run build && npm run test",
    because: "package.json scripts: check, build, test",
  });
});

test("the lockfile picks the package manager; npm's placeholder test script is not a test", () => {
  const [pnpm] = detectStarters(new Map([["package.json", pkg({ test: "jest" })], ["pnpm-lock.yaml", ""]]));
  assert.equal(pnpm!.command, "corepack enable && pnpm install --frozen-lockfile && pnpm run test");
  assert.equal(pnpm!.recipe, "project-check");
  assert.equal(pnpm!.directory, "");
  const [yarn] = detectStarters(new Map([["app/package.json", pkg({ lint: "eslint ." })], ["app/yarn.lock", ""]]));
  assert.equal(yarn!.command, "corepack enable && yarn install --immutable && yarn run lint");
  assert.deepEqual(
    detectStarters(new Map([["package.json", pkg({ test: 'echo "Error: no test specified" && exit 1' })]])),
    [],
  );
});

test("Rust, Go and Python projects are recognised by their own files", () => {
  const found = detectStarters(
    new Map([
      ["engine/Cargo.toml", ""],
      ["server/go.mod", ""],
      ["tools/requirements.txt", ""],
      ["lib/pyproject.toml", ""],
    ]),
  );
  assert.deepEqual(
    found.map((s) => [s.recipe, s.command]),
    [
      ["engine-check", "cargo test"],
      ["lib-check", "python -m pip install -e . && python -m pytest"],
      ["server-check", "go vet ./... && go test ./..."],
      ["tools-check", "python -m pip install -r requirements.txt && python -m pytest"],
    ],
  );
});

test("two folders with the same last name keep apart by their full path", () => {
  const found = detectStarters(
    new Map([
      ["app/web/package.json", pkg({ test: "vitest" })],
      ["site/web/package.json", pkg({ test: "vitest" })],
    ]),
  );
  assert.deepEqual(found.map((s) => s.recipe), ["app-web-check", "site-web-check"]);
});
