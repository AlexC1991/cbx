/**
 * Reading a repository address, and nothing else.
 *
 * Kept apart from the transfer itself so a test can exercise it directly:
 * importing the command drags in the API client and the upload engine, and
 * none of that is needed to decide that `gitlab.com/group/subgroup/project`
 * belongs to `group/subgroup`. It is also the piece where a mistake is quiet —
 * a URL parsed into the wrong owner still clones and still pushes, and only
 * the project name afterwards says anything was wrong.
 */

/** Which host a URL belongs to, and what to call on it. */
export type Forge = {
  kind: "github" | "gitlab" | "gitea";
  /** Human name, for the report. */
  label: string;
  host: string;
  owner: string;
  repo: string;
  /** The clone URL, always https so no key is needed for a public repository. */
  clone: string;
  /** Where the token comes from, if one is set. */
  tokenNames: string[];
};

/**
 * Work out which forge a URL points at.
 *
 * Gitea is the fallback rather than a failure: Codeberg, Forgejo and every
 * self-hosted Gitea share one API shape, so an unknown host is far more likely
 * to be one of those than to be nothing. Guessing wrong costs a failed
 * metadata read, which is reported; refusing outright would cost the transfer.
 */
export function readForgeUrl(input: string): Forge {
  let raw = input.trim();
  // `git@host:owner/repo.git` is not a URL; make it one.
  const ssh = raw.match(/^git@([^:]+):(.+)$/);
  if (ssh) raw = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`That does not look like a repository address: ${input}`);
  }
  const parts = parsed.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `That address names no repository: ${input}\n` +
        `  Expected something like https://github.com/owner/project`,
    );
  }
  /*
    GitLab allows groups within groups, so the project is the last segment and
    the owner is everything before it. Taking parts[0] would address the top
    group and miss the project entirely.
  */
  const repo = parts[parts.length - 1]!;
  const owner = parts.slice(0, -1).join("/");
  const host = parsed.host;

  const kind = /(^|\.)github\.com$/i.test(host)
    ? "github"
    : /(^|\.)gitlab\.com$/i.test(host)
      ? "gitlab"
      : "gitea";
  return {
    kind,
    label:
      kind === "github" ? "GitHub" : kind === "gitlab" ? "GitLab" : `Gitea (${host})`,
    host,
    owner,
    repo,
    clone: `https://${host}/${owner}/${repo}.git`,
    tokenNames:
      kind === "github"
        ? ["GITHUB_TOKEN", "GH_TOKEN"]
        : kind === "gitlab"
          ? ["GITLAB_TOKEN"]
          : ["FORGE_TOKEN", "GITEA_TOKEN"],
  };
}
