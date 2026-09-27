/**
 * The decisions the git remote helper makes, with nothing plugged in.
 *
 * Ordering a version graph, reading and writing the commit marker, parsing a
 * remote URL, quoting a path for fast-import: none of it needs a network, a
 * token, an upload engine or a git binary, and all of it is where a mistake is
 * silent rather than loud. Kept apart so a test can exercise it directly —
 * importing the helper itself drags in the uploader and the downloader, which
 * is why this file exists at all.
 */

/**
 * Git's constant hash for the empty tree.
 *
 * Diffing a root commit against this gives the same "everything is added"
 * answer as a normal parent diff, so the first commit is not a special case
 * with its own code path to get wrong.
 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The line that ties a CodeRook version back to the git commit it came from.
 *
 * Written into the version message because it has to survive somewhere both
 * machines can see. A file under `.git/` would be invisible to a colleague and
 * to this same person on another laptop, and the consequence of losing the
 * mapping is not a missing feature — it is re-pushing a history the project
 * already holds, as a second copy. `git-svn` and `git-p4` put their marker in
 * the message for the same reason.
 */
export const TRAILER = "CodeRook-Git-Commit:";

/** `coderook://project`, `coderook://owner/project`, `coderook::project`. */
export function parseRemoteUrl(url: string): { owner: string; slug: string } {
  let rest = url.trim();
  for (const prefix of ["coderook://", "coderook::", "coderook:"]) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  rest = rest.replace(/^\/+/, "").replace(/\/+$/, "");
  /*
    The owner is carried, and what it is used for differs by direction.
    Fetching honours it, because `coderook://somebody/their-project` is the
    line printed on every public project page and it has to reach their
    project rather than look for that name on yours. Pushing still ignores
    it: the token says who you are, and quietly publishing to an account the
    URL named instead would be the worse mistake of the two.
  */
  const parts = rest.split("/").filter(Boolean);
  const slug = parts[parts.length - 1] ?? "";
  const owner = parts.length > 1 ? parts[parts.length - 2]! : "";
  if (!slug) throw new Error(`Not a CodeRook remote URL: ${url}`);
  return { owner, slug };
}

/**
 * Pull the git commit id back out of a version message, if it carries one.
 *
 * The *last* marker wins. A message can hold more than one after a round trip
 * — clone a project, push it back, and the message carries the marker it was
 * imported with plus the one this publish adds. Taking the first would name
 * the commit from the original repository rather than the one just published,
 * and every incremental push after that would compute its range from a commit
 * this repository has never heard of.
 */
export function commitFromMessage(message: string): string | null {
  const all = [
    ...message.matchAll(new RegExp(`${TRAILER}\\s*([0-9a-f]{40})\\b`, "g")),
  ];
  return all.length ? all[all.length - 1]![1]! : null;
}

/**
 * What a version message may hold, matching the service.
 *
 * Not a guess and not a safety margin: the publish endpoint trims and then
 * refuses anything longer, so exceeding it fails the whole push rather than
 * being quietly shortened somewhere along the way.
 */
export const MESSAGE_LIMIT = 240;

/**
 * Attach the marker to a commit message, within what the service will accept.
 *
 * The marker is not decoration — it is how a version is tied back to the
 * commit it came from, and losing it means a later push republishes history
 * the project already holds. So when the two together are too long, the
 * message gives way and the marker survives.
 *
 * Git's own convention decides how: the first line is the summary and the rest
 * is detail, so as much as fits is kept and the remainder is cut on a word
 * boundary. A repository with a two-paragraph commit message would otherwise
 * fail the push outright — which is what it did, on a real transfer, with an
 * error naming a limit the person had never heard of.
 */
export function messageWithCommit(message: string, sha: string): string {
  const trailer = `\n\n${TRAILER} ${sha}`;
  const room = MESSAGE_LIMIT - trailer.length;
  const body = message.replace(/\s+$/, "");
  if (body.length <= room) return `${body}${trailer}`;

  /*
    Cut on a word boundary when one is reasonably near the end, so the result
    reads as a shortened sentence rather than a severed one. The ellipsis is
    what tells a reader there was more.
  */
  const kept = body.slice(0, room - 1);
  const tidy = kept.replace(/\s+\S*$/, "");
  const shortened = (tidy.length > room / 2 ? tidy : kept).trimEnd();
  /*
    A message of nothing but whitespace would leave an empty string, which the
    service refuses for its own reason: it requires at least one character.
  */
  return `${shortened || sha.slice(0, 8)}…${trailer}`;
}

/**
 * The message as a person wrote it, with our bookkeeping taken back out.
 *
 * Used when rebuilding git commits: the marker names the commit a version came
 * *from*, which is not the commit being created here, so leaving it in would
 * stamp every imported commit with a false identity.
 */
export function messageWithoutMarker(message: string): string {
  return message
    .replace(new RegExp(`^\\s*${TRAILER}\\s*[0-9a-f]{40}\\s*$`, "gm"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `refs/tags/v1.0` -> `v1.0`. Anything else is not a tag. */
export function tagOf(ref: string): string | null {
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : null;
}

/** `refs/heads/main` -> `main`. Anything else is not a branch. */
export function branchOf(ref: string): string | null {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

/**
 * Every version reachable from these heads, oldest first.
 *
 * A plain sort by sequence would look right and be wrong: sequences are handed
 * out per project as versions are made, so two lines interleave in a way that
 * has nothing to do with ancestry. Walking `parentVersionIds` and emitting a
 * version only once all of its parents have been emitted is what makes a
 * commit's parents exist by the time git is told about them — fast-import
 * refuses a mark it has not seen, so getting this wrong fails loudly, which is
 * the one mercy of it.
 */
export function versionsInOrder<
  T extends { id: string; parentVersionIds: string[] },
>(heads: string[], all: T[]): T[] {
  const byId = new Map(all.map((version) => [version.id, version]));

  // Everything the heads can reach. Iterative rather than recursive: a long
  // project is thousands of versions deep and a stack is not.
  const reachable = new Set<string>();
  const pending = [...heads];
  while (pending.length) {
    const id = pending.pop()!;
    if (!id || reachable.has(id) || !byId.has(id)) continue;
    reachable.add(id);
    for (const parent of byId.get(id)!.parentVersionIds) pending.push(parent);
  }

  const emitted = new Set<string>();
  const order: T[] = [];
  /*
    Depth-first with an explicit stack, visiting parents before the child. The
    `expanded` flag is what separates "I have queued this one's parents" from
    "its parents are done", without which a diamond history emits the join
    twice.
  */
  const stack: Array<{ id: string; expanded: boolean }> = heads
    .filter((id) => reachable.has(id))
    .map((id) => ({ id, expanded: false }));
  while (stack.length) {
    const frame = stack.pop()!;
    if (emitted.has(frame.id)) continue;
    const version = byId.get(frame.id);
    if (!version) continue;
    if (frame.expanded) {
      emitted.add(frame.id);
      order.push(version);
      continue;
    }
    stack.push({ id: frame.id, expanded: true });
    for (const parent of version.parentVersionIds) {
      if (reachable.has(parent) && !emitted.has(parent)) {
        stack.push({ id: parent, expanded: false });
      }
    }
  }
  return order;
}

/** Seconds since the epoch, for a fast-import person stamp. */
export function stamp(when: string): number {
  const at = Date.parse(when);
  return Number.isFinite(at) ? Math.floor(at / 1000) : Math.floor(Date.now() / 1000);
}

/**
 * Where an imported branch is written.
 *
 * Into the helper's own namespace rather than `refs/heads/*`, matching the
 * `refspec` advertised in `capabilities`. Writing straight to `refs/heads/*`
 * would have this remote overwrite local branches of the same name on every
 * fetch.
 */
export function importRef(ref: string): string {
  const branch = branchOf(ref);
  return branch ? `refs/coderook/${branch}` : ref;
}

/** fast-import wants a path C-quoted when it holds a quote or a newline. */
export function quotePath(filePath: string): string {
  const normalised = filePath.replaceAll("\\", "/");
  if (!/["\n\r]/.test(normalised)) return normalised;
  return `"${normalised
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

/**
 * Where each ref git asked for has to be pointed, once the commits exist.
 *
 * Git holds the helper to the whole batch: it names the refs it wants, and
 * if any one of them does not exist when the stream ends it aborts the fetch
 * — `could not read ref refs/coderook/<name>` — and the clone fails with
 * nothing to show for it.
 *
 * Emitting commits is not enough to guarantee that, because a commit is
 * written once per *version* while refs are per *line*. Two lines can share
 * one version — making a line from where another already is does exactly
 * that — so a single commit is expected to satisfy two refs, and only the
 * first is written. A line whose version arrived in an earlier fetch has no
 * commit emitted for it at all, and lands in the same hole.
 *
 * So each ref is stated separately rather than inferred from the commits.
 * A ref whose head has no mark is reported rather than guessed at: pointing
 * it somewhere plausible would hand back a branch that is quietly not the
 * one asked for.
 */
export function refPlacements(
  wanted: Iterable<readonly [string, string]>,
  markOfVersion: ReadonlyMap<string, number>,
): {
  placed: Array<{ ref: string; mark: number }>;
  unplaceable: string[];
} {
  const placed: Array<{ ref: string; mark: number }> = [];
  const unplaceable: string[] = [];
  for (const [ref, head] of wanted) {
    const mark = markOfVersion.get(head);
    if (mark === undefined) unplaceable.push(ref);
    else placed.push({ ref, mark });
  }
  return { placed, unplaceable };
}

/**
 * The versions within `depth` generations of these heads: 1 is the heads
 * alone, 2 adds their parents, and so on.
 *
 * What `git clone --depth` means here. The oldest version taken is imported
 * with no parent, so it becomes a root commit — which also means its commit id
 * differs from the same version's id in a full clone, because a commit's id
 * covers its parents. That is the same trade git's own shallow clones make.
 */
export function withinDepth<
  T extends { id: string; parentVersionIds: string[] },
>(heads: string[], all: T[], depth: number): Set<string> {
  const byId = new Map(all.map((version) => [version.id, version]));
  const kept = new Set<string>();
  let level = heads.filter((id) => byId.has(id));
  for (let generation = 0; generation < depth && level.length; generation += 1) {
    const next: string[] = [];
    for (const id of level) {
      if (kept.has(id)) continue;
      kept.add(id);
      for (const parent of byId.get(id)!.parentVersionIds) {
        if (byId.has(parent) && !kept.has(parent)) next.push(parent);
      }
    }
    level = next;
  }
  return kept;
}

/**
 * History an earlier shallow clone chose not to take.
 *
 * Every ancestor of something already imported that was not itself imported.
 * A full clone imported every ancestor, so for it this is always empty; for a
 * shallow one it is everything below the cut. Without it the first ordinary
 * `git fetch` after a `--depth 1` clone would import the whole history anyway,
 * as a second, disconnected line of commits nobody asked for.
 */
export function historyLeftOut<
  T extends { id: string; parentVersionIds: string[] },
>(all: T[], imported: Iterable<string>): Set<string> {
  const byId = new Map(all.map((version) => [version.id, version]));
  const have = new Set(imported);
  const left = new Set<string>();
  const pending: string[] = [];
  for (const id of have) {
    for (const parent of byId.get(id)?.parentVersionIds ?? []) pending.push(parent);
  }
  while (pending.length) {
    const id = pending.pop()!;
    if (have.has(id) || left.has(id) || !byId.has(id)) continue;
    left.add(id);
    for (const parent of byId.get(id)!.parentVersionIds) pending.push(parent);
  }
  return left;
}
