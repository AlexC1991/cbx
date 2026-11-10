/**
 * cbx workspace starter <project> [--apply] [--root folder]
 *
 * A draft can run checks only through recipes, and a recipe needs a workflow
 * with a command behind it. A new project has neither, so the first person or
 * assistant to open a draft finds "An administrator must configure this named
 * workspace recipe first" and nothing to run.
 *
 * This reads the project folder and proposes one check recipe per package it
 * recognises (Node by its lockfile, Python, Rust, Go), shows the plan, and with
 * --apply creates the workflows and recipes. It never replaces a recipe or a
 * workflow that already exists, and it never makes deploy recipes: those carry
 * credentials and targets, which only the project's owner can choose.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { callApi, workflows } from "./api.js";
import { accent, bold, dim, green } from "./colour.js";
import type { Parsed } from "./registry.js";

export type Starter = {
  /** Recipe name, e.g. "web-check". */
  recipe: string;
  /** Workflow name, e.g. "Draft check · web". */
  workflow: string;
  /** Folder the command runs in, relative to the project root; "" for the root. */
  directory: string;
  command: string;
  /** What the command was built from, for the plan. */
  because: string;
};

/** Files a starter is decided from, by project-relative path. */
export type Seen = ReadonlyMap<string, string>;

const SKIP = new Set(["node_modules", ".git", ".coderook", ".rook", "dist", "build", "target", ".venv", "venv", "vendor", ".next"]);

const slug = (directory: string) =>
  (directory.split("/").pop() || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

function nodeStarter(directory: string, seen: Seen): Starter | null {
  const at = (name: string) => (directory ? `${directory}/${name}` : name);
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(seen.get(at("package.json")) ?? "{}") as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }
  const has = (name: string) => typeof scripts[name] === "string" && !/no test specified/.test(String(scripts[name]));
  /* Fastest first, so a draft hears about a type error before waiting on the tests. */
  const steps = ["check", "typecheck", "lint", "build", "test"].filter(has);
  if (!steps.length) return null;
  const [install, run] = seen.has(at("pnpm-lock.yaml"))
    ? ["corepack enable && pnpm install --frozen-lockfile", "pnpm run"]
    : seen.has(at("yarn.lock"))
      ? ["corepack enable && yarn install --immutable", "yarn run"]
      : seen.has(at("package-lock.json"))
        ? ["npm ci", "npm run"]
        : ["npm install", "npm run"];
  return {
    recipe: `${slug(directory)}-check`,
    workflow: `Draft check · ${directory || "project"}`,
    directory,
    command: [install, ...steps.map((s) => `${run} ${s}`)].join(" && "),
    because: `package.json scripts: ${steps.join(", ")}`,
  };
}

/** The starters a folder's files suggest, one per recognised package. */
export function detectStarters(seen: Seen): Starter[] {
  const directories = new Set<string>();
  for (const path of seen.keys()) {
    const cut = path.lastIndexOf("/");
    directories.add(cut === -1 ? "" : path.slice(0, cut));
  }
  const out: Starter[] = [];
  for (const directory of [...directories].sort()) {
    const at = (name: string) => (directory ? `${directory}/${name}` : name);
    const node = seen.has(at("package.json")) ? nodeStarter(directory, seen) : null;
    if (node) out.push(node);
    else if (seen.has(at("Cargo.toml")))
      out.push({ recipe: `${slug(directory)}-check`, workflow: `Draft check · ${directory || "project"}`, directory, command: "cargo test", because: "Cargo.toml" });
    else if (seen.has(at("go.mod")))
      out.push({ recipe: `${slug(directory)}-check`, workflow: `Draft check · ${directory || "project"}`, directory, command: "go vet ./... && go test ./...", because: "go.mod" });
    else if (seen.has(at("pyproject.toml")) || seen.has(at("requirements.txt"))) {
      const install = seen.has(at("requirements.txt")) ? "python -m pip install -r requirements.txt" : "python -m pip install -e .";
      out.push({ recipe: `${slug(directory)}-check`, workflow: `Draft check · ${directory || "project"}`, directory, command: `${install} && python -m pytest`, because: seen.has(at("pyproject.toml")) ? "pyproject.toml" : "requirements.txt" });
    }
  }
  /* Two folders with the same last name ("app/web", "site/web") keep apart by their full path. */
  const names = new Map<string, number>();
  for (const s of out) names.set(s.recipe, (names.get(s.recipe) ?? 0) + 1);
  for (const s of out)
    if ((names.get(s.recipe) ?? 0) > 1)
      s.recipe = `${s.directory.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"}-check`;
  return out;
}

const MARKERS = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"]);

/** The marker files in a folder, two levels deep, skipping dependencies and build output. */
async function scan(root: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const walk = async (rel: string, depth: number) => {
    const entries = await readdir(join(root, ...rel.split("/").filter(Boolean)), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < 2 && !SKIP.has(entry.name) && !entry.name.startsWith(".")) await walk(path, depth + 1);
      } else if (MARKERS.has(entry.name)) {
        seen.set(path, entry.name === "package.json" ? await readFile(join(root, ...path.split("/")), "utf8") : "");
      }
    }
  };
  await walk("", 0);
  return seen;
}

export async function commandWorkspaceStarter(parsed: Parsed, root: string): Promise<number> {
  const folder = resolve(String(parsed.flags.get("root") ?? process.cwd()));
  if (!existsSync(folder)) throw new Error(`${folder} does not exist`);
  const starters = detectStarters(await scan(folder));
  const existing = await callApi<{ recipes?: { name: string }[] }>(`${root}/workspace-recipes`);
  const taken = new Set((existing.recipes ?? []).map((r) => r.name));
  const fresh = starters.filter((s) => !taken.has(s.recipe));
  const json = parsed.flags.has("json");
  if (!starters.length) {
    if (json) console.log(JSON.stringify({ starters: [] }));
    else console.log("No package.json scripts, Cargo.toml, go.mod or Python project found here. Pass --root with the project folder.");
    return 0;
  }
  if (!parsed.flags.has("apply")) {
    if (json) console.log(JSON.stringify({ starters, existing: [...taken] }, null, 2));
    else {
      for (const s of starters) {
        const kept = taken.has(s.recipe);
        console.log(`${kept ? dim("exists ") : green("new    ")} ${bold(s.recipe)}  ${dim(`in ${s.directory || "."}`)}`);
        if (!kept) console.log(`         ${s.command}\n         ${dim(s.because)}`);
      }
      console.log(
        fresh.length
          ? dim(`\nNothing was created. Add ${fresh.length === 1 ? "it" : "them"} with `) + accent("--apply") + dim("; drafts then run them with cbx workspace run <project> <draft> --recipe <name>.")
          : dim("\nEvery suggested recipe already exists."),
      );
    }
    return 0;
  }
  const project = root.split("/").pop()!;
  const known = new Map((await workflows(decodeURIComponent(project))).map((w) => [w.name, w.id]));
  const made: string[] = [];
  for (const s of fresh) {
    /* A workflow of the same name is reused as it is, never rewritten. */
    let workflowId = known.get(s.workflow);
    if (!workflowId) {
      const created = await callApi<{ id: string }>(`${root}/workflows`, {
        method: "POST",
        body: { name: s.workflow, trigger: "manual", command: s.command, workingDirectory: s.directory || null, runsOn: "hosted" },
      });
      workflowId = created.id;
    }
    await callApi(`${root}/workspace-recipes/${encodeURIComponent(s.recipe)}`, {
      method: "PUT",
      body: { kind: "check", workflowId, includePaths: s.directory ? [`${s.directory}/`] : [] },
    });
    made.push(s.recipe);
  }
  if (json) console.log(JSON.stringify({ created: made, existing: [...taken] }, null, 2));
  else if (made.length) console.log(`${green("Added")} ${made.join(", ")}. Run one on a draft with ${accent("cbx workspace run <project> <draft> --recipe <name>")}.`);
  else console.log("Every suggested recipe already exists; nothing was changed.");
  return 0;
}
