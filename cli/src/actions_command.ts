/**
 * The newer parts of Actions from the terminal:
 *
 *   cbx secret list | set NAME | remove NAME     a project's secrets
 *   cbx actions check [files…]                   check workflow files before saving them
 *   cbx actions set <action> --schedule … --timeout … --approval on|off --concurrency …
 *   cbx approve <run>                            let a run that waits for approval start
 *
 * A secret's value is never printed and never taken as an argument (it would
 * sit in shell history): it is read from standard input, from another
 * environment variable with --from-env, or typed at a hidden prompt.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { callApi, changeWorkflow, runs, workflows } from "./api.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";

function projectFlag(parsed: Parsed): string | undefined {
  const named = parsed.flags.get("project");
  return typeof named === "string" ? named : undefined;
}

/** Read a secret without it appearing anywhere: piped in, from another variable, or typed hidden. */
async function readSecretValue(name: string, parsed: Parsed): Promise<string | null> {
  const fromEnv = parsed.flags.get("from-env");
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    const value = process.env[fromEnv.trim()];
    if (!value) {
      console.error(red(`The environment variable ${fromEnv.trim()} is empty or not set.`));
      return null;
    }
    return value;
  }
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stdout.write(`Value for ${name} (hidden; Enter to finish): `);
  return new Promise((resolve) => {
    const input = process.stdin;
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (result: string | null) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (key: string) => {
      for (const character of key) {
        if (character === "\r" || character === "\n") return done(value);
        if (character === "\u0003") return done(null); // Ctrl+C
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", onData);
  });
}

export async function commandSecret(parsed: Parsed): Promise<number> {
  const sub = parsed.positional[0] ?? "list";
  const project = await resolveProject(projectFlag(parsed));
  if (!project) return 1;
  const base = `/v1/repositories/${encodeURIComponent(project.id)}/secrets`;

  if (sub === "list") {
    const { secrets } = await callApi<{ secrets: Array<{ name: string; updatedAt: string; updatedBy: string | null }> }>(base);
    if (!secrets.length) {
      console.log(`${bold(project.slug)} has no secrets.`);
      console.log(dim("  Add one: cbx secret set DEPLOY_TOKEN   (you are asked for the value; it is never shown)"));
      return 0;
    }
    console.log(bold(`Secrets in ${project.slug}`) + dim(" — values are never shown"));
    for (const secret of secrets) {
      console.log(`  ${accent(secret.name.padEnd(28))} ${dim(`set ${new Date(secret.updatedAt).toLocaleString()}${secret.updatedBy ? ` by ${secret.updatedBy}` : ""}`)}`);
    }
    return 0;
  }

  const name = (parsed.positional[1] ?? "").trim().toUpperCase();
  if (!name) {
    console.error(red(`Name the secret: cbx secret ${sub} DEPLOY_TOKEN`));
    return 1;
  }
  if (sub === "set") {
    const value = await readSecretValue(name, parsed);
    if (value === null) return 1;
    if (!value) {
      console.error(red("Nothing was entered, so nothing was saved."));
      return 1;
    }
    await callApi(`${base}/${encodeURIComponent(name)}`, { method: "PUT", body: { value } });
    console.log(`${green("Saved.")} Runs started by people who can change ${project.slug} get ${accent(name)} as an environment variable.`);
    console.log(dim("  It is replaced by *** in run logs. A run from outside the project never gets it."));
    return 0;
  }
  if (sub === "remove") {
    await callApi(`${base}/${encodeURIComponent(name)}`, { method: "DELETE" });
    console.log(`${green("Removed")} ${name}.`);
    return 0;
  }
  console.error(red(`cbx secret has no "${sub}". `) + "Try: list, set, remove");
  return 1;
}

type CheckAnswer = {
  ok: boolean;
  errors: string[];
  workflows: Array<{ name: string; on: string[]; schedule: string | null; needs: string[]; matrix: Record<string, unknown[]> | null; needsApproval: boolean; timeoutMinutes: number | null; runsOn: string }>;
};

const EVENT_WORDS: Record<string, string> = {
  manual: "by hand",
  version_saved: "on save",
  merge_opened: "on pull requests",
  merge_applied: "when merged",
  issue_opened: "issue opened",
  issue_labeled: "issue labelled",
  issue_commented: "issue comment",
  release_published: "on release",
  schedule: "on a schedule",
};

/** `cbx actions check [files…]`: what each file would make, and what is wrong with it. */
export async function commandCheckWorkflows(parsed: Parsed): Promise<number> {
  let files = parsed.positional.slice(1);
  if (!files.length) {
    const folder = path.join(process.cwd(), ".rook", "workflows");
    try {
      files = (await readdir(folder)).filter((name) => /\.ya?ml$/.test(name)).map((name) => path.join(folder, name));
    } catch {
      files = [];
    }
  }
  if (!files.length) {
    console.log("No workflow files here. They live in .rook/workflows/*.yml");
    console.log(dim("  See: https://coderook.com/docs#workflow-files"));
    return 0;
  }
  const project = await resolveProject(projectFlag(parsed));
  if (!project) return 1;
  let failed = false;
  for (const file of files) {
    const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
    const text = await readFile(file, "utf8");
    const answer = await callApi<CheckAnswer>(`/v1/repositories/${encodeURIComponent(project.id)}/workflow-files/check`, {
      method: "POST",
      body: { path: relative.startsWith(".rook/") ? relative : `.rook/workflows/${path.basename(file)}`, text },
    });
    console.log(answer.ok ? `${green("✓")} ${bold(relative)}` : `${red("×")} ${bold(relative)}`);
    for (const error of answer.errors) console.log(`    ${red(error)}`);
    for (const workflow of answer.workflows) {
      const details = [
        workflow.on.map((event) => EVENT_WORDS[event] ?? event).join(", "),
        workflow.schedule ? `"${workflow.schedule}" UTC` : null,
        workflow.runsOn !== "hosted" ? `on ${workflow.runsOn}` : null,
        workflow.matrix ? `${Object.values(workflow.matrix).reduce((all, values) => all * values.length, 1)} runs (matrix)` : null,
        workflow.needs.length ? `after ${workflow.needs.join(", ")}` : null,
        workflow.needsApproval ? "needs approval" : null,
        workflow.timeoutMinutes ? `${workflow.timeoutMinutes} min limit` : null,
      ].filter(Boolean);
      console.log(`    ${accent(workflow.name)} ${dim(details.join(" · "))}`);
    }
    failed ||= !answer.ok;
  }
  if (!failed) console.log(dim("\nSave them to the project's main line and they take effect."));
  return failed ? 1 : 0;
}

/** `cbx actions set <action> …`: the options a workflow made on the website can have. */
export async function commandSetWorkflow(parsed: Parsed): Promise<number> {
  const named = (parsed.positional[1] ?? "").trim();
  if (!named) {
    console.error(red('Which action? cbx actions set "Nightly build" --schedule "0 3 * * *"'));
    return 1;
  }
  const project = await resolveProject(projectFlag(parsed));
  if (!project) return 1;
  const target = (await workflows(project.id)).find((one) => one.name.toLowerCase() === named.toLowerCase());
  if (!target) {
    console.error(red(`${project.name} has no action called ${named}.`));
    return 1;
  }
  const change: Record<string, unknown> = {};
  const schedule = parsed.flags.get("schedule");
  if (typeof schedule === "string") {
    change.schedule = schedule === "off" ? null : schedule;
    if (schedule !== "off") change.trigger = "schedule";
  }
  const timeout = parsed.flags.get("timeout");
  if (typeof timeout === "string") change.timeoutMinutes = timeout === "off" ? null : Number(timeout);
  const approval = parsed.flags.get("approval");
  if (typeof approval === "string") change.needsApproval = approval === "on";
  const concurrency = parsed.flags.get("concurrency");
  if (typeof concurrency === "string") change.concurrencyGroup = concurrency === "off" ? null : concurrency;
  if (parsed.flags.has("cancel-old")) change.cancelInProgress = true;
  if (parsed.flags.has("keep-old")) change.cancelInProgress = false;
  if (!Object.keys(change).length) {
    console.error(red("Nothing to change. ") + dim("Options: --schedule, --timeout, --approval on|off, --concurrency, --cancel-old"));
    return 1;
  }
  await changeWorkflow(project.id, target.id, change);
  console.log(`${green("Saved.")} ${target.name}:`);
  if ("schedule" in change) console.log(`  ${change.schedule ? `runs on "${change.schedule}" (UTC)` : "no schedule"}`);
  if ("timeoutMinutes" in change) console.log(`  ${change.timeoutMinutes ? `stopped after ${change.timeoutMinutes} minutes` : "no time limit of its own"}`);
  if ("needsApproval" in change) console.log(`  ${change.needsApproval ? "each run waits for approval (cbx approve)" : "runs start without approval"}`);
  if ("concurrencyGroup" in change) console.log(`  ${change.concurrencyGroup ? `one at a time in "${change.concurrencyGroup}"` : "no concurrency group"}`);
  if ("cancelInProgress" in change) console.log(`  ${change.cancelInProgress ? "a new run cancels the group's older ones" : "a new run waits its turn"}`);
  return 0;
}

/** `cbx approve <run>`: start a run that is waiting for approval. */
export async function commandApprove(parsed: Parsed): Promise<number> {
  const asked = parsed.positional[0];
  const number = Number((asked ?? "").replace(/^#/, ""));
  if (!asked || !Number.isInteger(number) || number < 1) {
    console.error(red("Which run? Try: cbx approve 12"));
    return 1;
  }
  const project = await resolveProject(parsed.positional[1] ?? projectFlag(parsed));
  if (!project) return 1;
  const run = (await runs(project.id)).find((one) => one.number === number);
  if (!run) {
    console.error(red(`${project.name} has no run #${number}.`));
    return 1;
  }
  await callApi(`/v1/repositories/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(run.id)}/approve`, { method: "POST" });
  console.log(`${accent(`#${number}`)} approved. It is queued and starts when a runner takes it.`);
  return 0;
}
