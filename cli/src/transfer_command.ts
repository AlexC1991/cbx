/**
 * Moving a whole repository off a git host and onto CodeRook.
 *
 * `cbx import` takes a snapshot: the files as they are now, one version, no
 * history. That is the right answer for "get this onto CodeRook quickly" and
 * the wrong one for "move off GitHub", where the history, the branches, the
 * tags and the issues are most of what somebody is worried about losing.
 *
 * ## It uses the public route on purpose
 *
 * The history goes across by running `git push` against the CodeRook remote —
 * the same command anybody else would type, through the same helper. Nothing
 * here reaches past it into a private path.
 *
 * That is deliberate, because the claim being made is interoperability. A
 * transfer that worked through a back door would prove only that a back door
 * exists. This one works because `git push coderook --all` works; if that ever
 * breaks, this breaks with it, loudly, rather than quietly diverging from what
 * users are told to do.
 *
 * ## What crosses, and what cannot
 *
 * Commits, branches, tags and the project's own description come across.
 * Issues come across when a read token is supplied. Pull requests, reviews,
 * CI configuration, stars and collaborator lists do not — some because
 * CodeRook has no such object, and one because it would be wrong: adding
 * somebody to a project is an invitation they have to accept, not a field to
 * copy. The report at the end says which is which rather than leaving the
 * absence to be discovered.
 *
 * ## Tokens
 *
 * Read from the environment, never from a flag and never stored. A read-only
 * token is enough, and no OAuth flow is offered: holding somebody's forge
 * credentials to run a one-off migration sits badly beside a front page that
 * promises their work is not handed to anybody.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createIssue, findProject, updateProject } from "./api.js";
import { readForgeUrl, type Forge } from "./forge_url.js";
import type { Parsed } from "./registry.js";

const dim = (value: string) => `[2m${value}[0m`;
const bold = (value: string) => `[1m${value}[0m`;
const red = (value: string) => `[31m${value}[0m`;
const green = (value: string) => `[32m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;

/** A read token from the environment, or nothing. Never a flag. */
function forgeToken(forge: Forge): string | null {
  for (const name of forge.tokenNames) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

async function readJson(
  url: string,
  token: string | null,
  forge: Forge,
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "cbx-transfer",
  };
  if (token) {
    headers.authorization =
      forge.kind === "gitlab" ? `Bearer ${token}` : `token ${token}`;
  }
  /* A forge that stops answering must not hold the import open for ever. */
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} from ${new URL(url).pathname}`);
  }
  return response.json();
}

type SourceFacts = {
  description: string;
  visibility: "private" | "public";
  defaultBranch: string | null;
};

/** What the forge says about the repository itself. */
async function describeSource(
  forge: Forge,
  token: string | null,
): Promise<SourceFacts | null> {
  const encoded = encodeURIComponent(`${forge.owner}/${forge.repo}`);
  const url =
    forge.kind === "github"
      ? `https://api.${forge.host}/repos/${forge.owner}/${forge.repo}`
      : forge.kind === "gitlab"
        ? `https://${forge.host}/api/v4/projects/${encoded}`
        : `https://${forge.host}/api/v1/repos/${forge.owner}/${forge.repo}`;
  try {
    const body = (await readJson(url, token, forge)) as Record<string, unknown>;
    const isPrivate =
      body.private === true || body.visibility === "private" || body.internal === true;
    return {
      description: String(body.description ?? "").slice(0, 1000),
      visibility: isPrivate ? "private" : "public",
      defaultBranch: (body.default_branch as string) ?? null,
    };
  } catch {
    return null;
  }
}

type SourceIssue = { title: string; body: string; number: number; closed: boolean };

/** Open issues on the source, oldest first so numbering reads sensibly. */
async function readIssues(
  forge: Forge,
  token: string | null,
): Promise<SourceIssue[]> {
  const encoded = encodeURIComponent(`${forge.owner}/${forge.repo}`);
  const url =
    forge.kind === "github"
      ? `https://api.${forge.host}/repos/${forge.owner}/${forge.repo}/issues?state=open&per_page=100`
      : forge.kind === "gitlab"
        ? `https://${forge.host}/api/v4/projects/${encoded}/issues?state=opened&per_page=100`
        : `https://${forge.host}/api/v1/repos/${forge.owner}/${forge.repo}/issues?state=open&limit=100`;
  const body = (await readJson(url, token, forge)) as Array<Record<string, unknown>>;
  return body
    /*
      GitHub returns pull requests through the issues endpoint. They are not
      issues, and CodeRook has nothing that a pull request becomes, so copying
      them across as issues would be inventing content rather than moving it.
    */
    .filter((one) => !one.pull_request)
    .map((one) => ({
      title: String(one.title ?? "").slice(0, 200),
      body: String(one.body ?? one.description ?? "").slice(0, 20_000),
      number: Number(one.number ?? one.iid ?? 0),
      closed: false,
    }))
    .filter((one) => one.title)
    .reverse();
}

function run(
  command: string,
  args: string[],
  cwd?: string,
): { ok: boolean; out: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

export async function commandTransfer(parsed: Parsed): Promise<number> {
  const address = parsed.positional[0];
  if (!address) {
    console.error(red("Which repository? Try: cbx transfer https://github.com/owner/project"));
    return 1;
  }

  let forge: Forge;
  try {
    forge = readForgeUrl(address);
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  if (!run("git", ["--version"]).ok) {
    console.error(red("Transferring needs git on this machine."));
    return 1;
  }
  /*
    The push goes through the remote helper, which git finds on PATH by name.
    Checking now turns a confusing failure halfway through a clone into one
    sentence before anything is downloaded.
  */
  if (!run("git", ["remote-coderook", "--probe"]).ok) {
    const help = run("git", ["help", "-a"]);
    if (!/remote-coderook/.test(help.out)) {
      console.error(red("git cannot find `git-remote-coderook` on this machine."));
      console.error(
        "It ships with this tool, so this usually means cbx was run from a\n" +
          "checkout rather than installed. Install it globally and try again:\n" +
          `  ${accent("npm install --global @coderook/cli")}`,
      );
      return 1;
    }
  }

  const wanted = (typeof parsed.flags.get("name") === "string"
    ? String(parsed.flags.get("name"))
    : forge.repo
  ).toLowerCase();

  const existing = await findProject(wanted);
  if (existing) {
    console.error(red(`You already have a project called ${existing.slug}.`));
    console.error(
      `Transfer creates a project; it does not merge into one. Choose another\n` +
        `name with ${accent("--name")}, or delete that project first.`,
    );
    return 1;
  }

  const token = forgeToken(forge);
  console.log(`${bold("Transferring")} ${forge.owner}/${forge.repo} ${dim(`from ${forge.label}`)}`);
  console.log(
    dim(
      token
        ? `  Using the read token in ${forge.tokenNames.find((name: string) => process.env[name]?.trim())}.`
        : `  No token set. Public repositories work; set ${forge.tokenNames[0]} for a private one or for issues.`,
    ),
  );

  const scratch = await mkdtemp(path.join(os.tmpdir(), "cbx-transfer-"));
  const checkout = path.join(scratch, forge.repo);
  const report: string[] = [];
  try {
    /*
      A full clone, not the shallow one `import` uses. The whole point here is
      the history, and `--depth 1` would silently deliver a single commit under
      a command whose name promises everything.
    */
    console.log(`\n${dim("Fetching the repository with its full history…")}`);
    const cloned = run("git", ["clone", "--no-single-branch", forge.clone, checkout]);
    if (!cloned.ok) {
      console.error(red(`\nCould not clone ${forge.clone}`));
      console.error(cloned.out.trim().split("\n").slice(-4).join("\n"));
      if (!token) {
        console.error(
          dim(`\nIf it is private, set ${forge.tokenNames[0]} and try again.`),
        );
      }
      return 1;
    }

    /*
      Every branch, not only the one checked out. A fresh clone has remote
      tracking refs for the rest, and nothing local pointing at them, so
      `--all` would push exactly one branch.
    */
    const remoteBranches = run("git", [
      "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin",
    ], checkout).out
      .split("\n").map((one) => one.trim()).filter(Boolean)
      /*
        The remote's HEAD symref comes back as plain `origin`, not
        `origin/HEAD`, so filtering on the latter leaves a phantom entry that
        inflates the branch count and sends git looking for `origin/origin`.
      */
      .filter((one) => one.startsWith("origin/"))
      .map((one) => one.slice("origin/".length))
      .filter((one) => one && one !== "HEAD");
    for (const branch of remoteBranches) {
      run("git", ["branch", "--force", branch, `origin/${branch}`], checkout);
    }

    const commits = Number(
      run("git", ["rev-list", "--all", "--count"], checkout).out.trim() || "0",
    );
    const tags = run("git", ["tag", "-l"], checkout).out.split("\n").filter(Boolean);
    console.log(
      `  ${commits} commit${commits === 1 ? "" : "s"} · ` +
        `${remoteBranches.length} branch${remoteBranches.length === 1 ? "" : "es"} · ` +
        `${tags.length} tag${tags.length === 1 ? "" : "s"}`,
    );
    if (commits > 200) {
      console.log(
        dim(
          `  Each commit becomes a version, so this will take a while —\n` +
            `  roughly ${Math.round((commits * 11) / 60)} minutes. It resumes if interrupted.`,
        ),
      );
    }

    run("git", ["remote", "add", "coderook", `coderook://${wanted}`], checkout);

    console.log(`\n${dim("Publishing the history…")}`);
    const pushed = run("git", ["push", "coderook", "--all"], checkout);
    process.stderr.write(pushed.out);
    if (!pushed.ok) {
      console.error(red("\nThe history did not transfer completely."));
      return 1;
    }
    report.push(`${commits} commits across ${remoteBranches.length} branch(es)`);

    if (tags.length) {
      const pushedTags = run("git", ["push", "coderook", "--tags"], checkout);
      process.stderr.write(pushedTags.out);
      report.push(
        pushedTags.ok
          ? `${tags.length} tag(s) as releases`
          : `tags were refused — see above`,
      );
    }

    const project = await findProject(wanted);
    if (!project) {
      console.error(red("\nThe project was not created. Nothing else was changed."));
      return 1;
    }

    // What the repository says about itself.
    const facts = await describeSource(forge, token);
    if (facts) {
      const asked = parsed.flags.get("visibility");
      /*
        Private unless asked otherwise, even when the source is public.
        Mirroring visibility is the faithful thing and publishing somebody's
        code by side effect is the unrecoverable thing, so the safe reading
        wins and the report says what was chosen.
      */
      const visibility =
        asked === "same"
          ? facts.visibility
          : asked === "public"
            ? "public"
            : "private";
      await updateProject(project.id, {
        ...(facts.description ? { description: facts.description } : {}),
        visibility,
      });
      report.push(
        `description and visibility (${visibility}` +
          `${visibility !== facts.visibility ? `, source was ${facts.visibility}` : ""})`,
      );
      /*
        Said rather than left to be noticed. Creating a project always makes a
        `main` line, so a repository whose default is anything else arrives
        with an empty one beside its real branches — and `cbx tracks` marks it
        as the current line, which reads as though the transfer lost the work.
      */
      if (facts.defaultBranch && facts.defaultBranch !== "main") {
        report.push(
          `default line is ${facts.defaultBranch}; the empty "main" beside it ` +
            `was made when the project was created`,
        );
      }
    } else {
      report.push("description could not be read from the source");
    }

    // Issues, only when asked and only with a token.
    if (parsed.flags.has("issues")) {
      if (!token) {
        report.push(
          `issues skipped — set ${forge.tokenNames[0]} and run with --issues again`,
        );
      } else {
        try {
          const issues = await readIssues(forge, token);
          let made = 0;
          for (const issue of issues) {
            await createIssue(project.id, {
              title: issue.title,
              body:
                `${issue.body}\n\n` +
                `— transferred from ${forge.label} ${forge.owner}/${forge.repo}#${issue.number}`,
            });
            made += 1;
          }
          report.push(`${made} open issue(s)`);
        } catch (error) {
          report.push(
            `issues failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    console.log(`\n${green("Transferred")} ${bold(project.slug)}`);
    for (const line of report) console.log(`  ${green("·")} ${line}`);
    console.log(`\n${dim("Not carried across:")}`);
    console.log(dim("  · pull requests and reviews — CodeRook has no equivalent object"));
    console.log(dim("  · CI configuration — runs are started deliberately, not by a push"));
    console.log(dim("  · collaborators — access is an invitation to accept, not a field to copy"));
    console.log(dim("  · stars, forks and watchers"));
    if (!parsed.flags.has("issues")) {
      console.log(dim("  · issues — pass --issues to bring the open ones"));
    }
    /*
      Said plainly rather than implied by the word "transfer".

      Nothing here checks whose repository this is, and nothing could: a public
      repository is readable by anybody, which is exactly why cloning one needs
      no token. What that means in practice is that this is `git clone`
      followed by a publish — no more permission than anyone already has, and
      no claim of ownership either. The licence that came with the files is
      still the thing that governs what may be done with them, which matters
      most at the moment somebody makes the project public.
    */
    console.log(
      [
        "",
        `${dim("On ownership:")} nothing was checked, and nothing could be.`,
        "A public repository is readable by anyone, which is why cloning one",
        "needs no token — so this is a clone and a publish, not a claim. The",
        "licence that came with the files is still what governs them.",
        ...(facts && facts.visibility === "public"
          ? ["Worth reading before you make this project public."]
          : []),
      ].join("\n"),
    );
    console.log(
      `\nFetch it anywhere with ${accent(`cbx clone ${project.slug}`)}` +
        `${dim(", or ")}${accent(`git clone coderook://${project.slug}`)}${dim(".")}`,
    );
    return 0;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
