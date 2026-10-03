/**
 * `git push coderook` — a git remote helper.
 *
 * Git looks for a program called `git-remote-<scheme>` on PATH when it meets a
 * remote URL it does not recognise, hands it the remote name and URL, and then
 * talks a small line protocol over stdin and stdout. This is that program for
 * `coderook://` URLs, which is what lets every editor's built-in git panel work
 * with CodeRook without any per-editor work.
 *
 * Both directions are implemented: `push` publishes each commit as a save, and
 * `import` rebuilds a git history from those saves so `git clone` and `git
 * fetch` work.
 *
 * The vocabulary matters here, because the two products do not agree by
 * accident. A pushed commit becomes a *commit* in CodeRook — a save, inside
 * the project, that nobody outside can see. Tagging it names it, and a named
 * save is a *version*, which is the only thing the public side offers. That
 * is the same distinction git already draws between a commit and a tag, so
 * the mapping is one-to-one rather than an approximation.
 *
 * A save also carries a description of its own, separate from its message.
 * That travels as a git note on `refs/notes/coderook` in both directions.
 *
 * ## Why the `push` capability rather than `export`
 *
 * A helper may declare `export`, in which case git runs `git fast-export` and
 * pipes the stream in. It is less code and it is the wrong shape here:
 * fast-export states each commit as a *delta against its parent*, so replaying
 * it onto one working tree is only correct while the history is a straight
 * line. The moment a branch or a merge appears, the tree a commit is applied to
 * is not the tree it was written against, and the version published is a blend
 * of two commits that never existed. That failure is silent — every file is
 * valid, the push reports success, and the contents are wrong.
 *
 * Declaring `push` instead means git tells us which refs to move and leaves the
 * method to us, so each commit is read as a *complete tree* and parentage never
 * has to be reconstructed. It also lets us diff any two commits directly, which
 * is what keeps the upload incremental.
 *
 * ## What is deliberately not supported
 *
 * Named here rather than discovered by failure:
 *
 * - **Tag kind.** A tag becomes a release and a release becomes a tag, but
 *   fast-import can only create annotated tags — so a lightweight tag pushed
 *   comes back annotated. CodeRook has no notion of the difference to record.
 * - **Force pushes and deletions.** CodeRook versions are immutable, so there
 *   is nothing to rewind to. Both are refused rather than silently ignored.
 * - **Submodules.** A gitlink is a pointer into another repository and there
 *   are no bytes to publish. Skipped on push, and said out loud.
 * - **File modes.** The executable bit travels both ways: a pushed `100755`
 *   is recorded as executable, and an executable file is fetched as `100755`.
 *   Versions saved before the bit was recorded come back `100644`.
 *
 * ## What a round trip does and does not preserve
 *
 * Push then clone returns the same *contents*, not the same *commits*. The
 * rebuilt commits have different ids, because a git commit id covers its
 * author, committer and timestamps, and CodeRook stores who published a
 * version but not the original stamps. So a clone of a pushed project is a
 * faithful copy of the files and an honest approximation of the history.
 *
 * Merges are asymmetric, and the asymmetry is in the service rather than here.
 * A publish states one base version, so pushing a git merge commit records one
 * parent and the second is lost — the merged *tree* is exact, the fork in the
 * history is not. Reading back is the richer direction: a version states its
 * parents in order, so a version that genuinely has two is rebuilt as a real
 * git merge commit. Push then clone therefore returns a straight line even
 * where the original branched.
 */
import { spawn, spawnSync } from "node:child_process";
import { isGitDirectoryName } from "../../cbx/src/shared/safe_path.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Uploader } from "../../cbx/src/core/upload.js";
import { readStoredZip } from "./stored_zip.js";
import { Tracks } from "../../cbx/src/core/tracks.js";
import { declareClient } from "../../cbx/src/core/identify.js";
import { credentials } from "./config.js";
import { VERSION } from "./version.js";
import { classifyPublishFailure, uploadRequestFor } from "./publish.js";
import {
  EMPTY_TREE,
  branchOf,
  tagOf,
  commitFromMessage,
  importRef,
  messageWithCommit,
  messageWithoutMarker,
  parseRemoteUrl,
  quotePath,
  refPlacements,
  stamp,
  historyLeftOut,
  versionsInOrder,
  withinDepth,
} from "./git_history.js";
import { findProject, whoami } from "./api.js";

/** A fetch that cannot be served. Carried out so the process can exit non-zero. */
class ImportFailed extends Error {}

/**
 * A failure this code has already explained.
 *
 * The entry point prints whatever reaches it, which is right for a surprise
 * and wrong for a refusal that has just been set out in full — the person
 * would read the same paragraph twice, the second time with a program name
 * in front of it.
 */
export class AlreadyReported extends Error {}

/**
 * A name as fast-import may carry it on an author, committer or tagger line.
 *
 * Every other line of the stream is built from values the helper made; these
 * come from what people typed. A newline in a display name ended the line and
 * began another — any command the stream accepts, a symlink or a ref update
 * included — and `<` or `>` would end the name early. Each becomes a space.
 */
function identity(name: string): string {
  return name.replace(/[\x00-\x1f\x7f<>]/g, " ").replace(/\s+/g, " ").trim() || "CodeRook";
}

/** Everything the helper writes for a person goes to stderr; stdout is protocol. */
function say(text: string): void {
  process.stderr.write(`${text}\n`);
}

function send(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Run git and return stdout as text. Throws with git's own message. */
function git(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || "").trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Where CodeRook keeps a save's description inside a git repository.
 *
 * `refs/notes/coderook` rather than git's default `refs/notes/commits`,
 * because the default is shared ground — anything else attaching notes writes
 * there too, and a fetch that overwrote somebody's own notes with ours would
 * be taking something that was not offered.
 */
const NOTES_REF = "refs/notes/coderook";

/**
 * The description attached to a commit, if there is one.
 *
 * Empty rather than throwing for every ordinary reason it can be missing: no
 * notes ref at all, no note on this commit, or a repository where notes have
 * never been used. None of those is a problem worth stopping a push for.
 */
function noteOn(sha: string): string {
  const result = spawnSync(
    "git",
    ["notes", `--ref=${NOTES_REF}`, "show", sha],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 8 },
  );
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/** Run git for its exit status alone. False rather than throwing. */
function gitOk(args: string[]): boolean {
  return (
    spawnSync("git", args, { encoding: "utf8", stdio: "ignore" }).status === 0
  );
}

/**
 * One long-lived `git cat-file --batch` process.
 *
 * A push reads one blob per changed path per commit, and starting a git process
 * for each costs more than the reading does. GitLab measured the same walk as
 * 70% faster with a single batch process, which is the whole reason this is a
 * class rather than a function that shells out.
 *
 * The protocol is: write `<object>\n`, read a header line
 * `<oid> <type> <size>\n`, then exactly `<size>` bytes, then one newline.
 */
class CatFile {
  private readonly child = spawn("git", ["cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  private buffer: Buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor() {
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const waiting = this.waiters;
      this.waiters = [];
      for (const wake of waiting) wake();
    });
    this.child.stdout.on("end", () => {
      this.closed = true;
      for (const wake of this.waiters) wake();
      this.waiters = [];
    });
  }

  private async more(): Promise<void> {
    if (this.closed) throw new Error("git cat-file closed unexpectedly");
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const at = this.buffer.indexOf(0x0a);
      if (at !== -1) {
        const line = this.buffer.subarray(0, at).toString("utf8");
        this.buffer = this.buffer.subarray(at + 1);
        return line;
      }
      await this.more();
    }
  }

  private async readBytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) await this.more();
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return Buffer.from(out);
  }

  /** The bytes of one blob, named as `<commit>:<path>` or by object id. */
  async blob(reference: string): Promise<Buffer> {
    this.child.stdin.write(`${reference}\n`);
    const header = await this.readLine();
    if (header.endsWith(" missing")) {
      throw new Error(`git has no object for ${reference}`);
    }
    const size = Number(header.split(" ")[2]);
    const body = await this.readBytes(size);
    await this.readBytes(1); // the trailing newline
    return body;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

type ChangeSet = {
  written: string[];
  deleted: string[];
  skipped: string[];
  /** Whether each written file is executable (git mode 100755). */
  executable: Map<string, boolean>;
};

/**
 * Bring the scratch tree from one commit to another, and say what moved.
 *
 * Renames are asked for as a delete plus an add (`--no-renames`) rather than
 * as a rename. CodeRook is content-addressed, so the added path costs nothing
 * to store when the bytes already exist, and the alternative is carrying a
 * second change shape through every branch below for no benefit.
 */
async function applyCommit(
  catFile: CatFile,
  scratch: string,
  fromCommit: string,
  toCommit: string,
): Promise<ChangeSet> {
  const raw = git([
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    fromCommit,
    toCommit,
  ]);
  const fields = raw.split("\0").filter((field) => field.length > 0);

  const written: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];
  const executable = new Map<string, boolean>();

  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const filePath = fields[index + 1]!;
    const target = path.join(scratch, filePath);

    if (status.startsWith("D")) {
      await rm(target, { force: true });
      deleted.push(filePath);
      continue;
    }

    /*
      A gitlink has a mode but no bytes. Writing the commit id it points at as
      the file's contents would produce a forty-byte text file where a
      directory belongs, which is worse than not publishing it.
    */
    const mode = git(["ls-tree", "-z", toCommit, "--", filePath])
      .split("\0")[0]
      ?.split(/\s+/)[0];
    if (mode === "160000") {
      skipped.push(filePath);
      continue;
    }

    const bytes = await catFile.blob(`${toCommit}:${filePath}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written.push(filePath);
    executable.set(filePath, mode === "100755");
  }

  return { written, deleted, skipped, executable };
}

/*
  The service's answer when a line is already there.

  Matched on the wording as well as the shape because the message is the only
  thing that reaches here: `This project already has a track called main`. The
  previous test looked for "exist", which that sentence does not contain — so a
  branch arriving after the project had been created was reported as a hard
  failure rather than the ordinary "it is already there".
*/
const TRACK_EXISTS = /already has a track|track_exists|exists/i;

type PushRequest = { src: string; dst: string; force: boolean };

/**
 * The order refs are published in, which is not the order git sends them.
 *
 * `git push --all` hands over every branch at once, and on a project that does
 * not exist yet the first one creates it — along with an empty `main`. If a
 * side branch happens to go first it takes the whole history, and `main`
 * arrives to find its own line already made and nothing it can do with it:
 * there is no way to move an existing line's head, only to start one at a
 * version. The result was a project whose default line was permanently empty.
 *
 * Publishing the branch the others fork from first makes every later branch an
 * ordinary fork, which is the case that already worked. Local HEAD wins,
 * because that is what the person is standing on; `main` and `master` are the
 * conventional fallbacks; everything else keeps a stable order so two runs of
 * the same push behave the same way.
 */
function ordered(requests: PushRequest[]): PushRequest[] {
  let head = "";
  try {
    head = git(["symbolic-ref", "--short", "HEAD"]).trim();
  } catch {
    // A detached HEAD has no branch to prefer; the fallbacks still apply.
  }
  const rank = (request: PushRequest) => {
    const branch = branchOf(request.dst);
    if (!branch) return 4; // tags last: they name versions that must exist
    if (branch === head) return 0;
    if (branch === "main") return 1;
    if (branch === "master") return 2;
    return 3;
  };
  return [...requests].sort(
    (left, right) => rank(left) - rank(right) || left.dst.localeCompare(right.dst),
  );
}

/**
 * The refs the remote already holds, as far as we can tell.
 *
 * Git uses this to work out which commits to send, so being wrong here is
 * expensive in both directions: claim too much and work is silently dropped,
 * claim too little and a history is published twice.
 */
async function remoteRefs(
  repositoryId: string | null,
): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  if (!repositoryId) return known;
  const state = await remoteState(repositoryId);
  const marks = await readMarks();
  for (const track of state.tracks) {
    if (track.kind !== "line" || !track.headVersionId) continue;
    const sha = headCommit(track.headVersionId, state, marks);
    if (sha) known.set(`refs/heads/${track.name}`, sha);
  }
  return known;
}

/**
 * Which commit *in this repository* holds a version.
 *
 * There are two answers and they are not interchangeable. The message marker
 * names the commit a version was published from, which is the right answer in
 * the repository that published it. The mark table names the commit this
 * repository built when it imported that version, which is the right answer in
 * a clone. A repository that cloned and then pushes has both, and they disagree
 * permanently — the imported commit is a different object with a different id.
 *
 * The mark wins, because git is about to be told this id and has to be able to
 * find it. Offering the marker instead makes every push from a clone fail with
 * "the remote has a commit you do not have", naming a commit that only exists
 * on somebody else's machine — which is precisely the loop this closed.
 */
function headCommit(
  versionId: string,
  state: RemoteState,
  marks: Marks | null,
): string | undefined {
  const mark = marks?.ofVersion.get(versionId);
  const imported = mark === undefined ? undefined : marks?.sha.get(mark);
  return imported ?? state.shaOfVersion.get(versionId);
}

type RemoteState = {
  tracks: Awaited<ReturnType<Tracks["list"]>>;
  /** Every git commit this project has published, to the version holding it. */
  versionOfSha: Map<string, string>;
  shaOfVersion: Map<string, string>;
  versionCount: number;
};

/**
 * Everything about the project that a push needs to decide anything.
 *
 * Gathered once per push rather than per branch: it is two calls, both of
 * which were being made repeatedly, and having one snapshot removes the
 * possibility of two decisions in the same push disagreeing about what the
 * remote holds.
 */
async function remoteState(repositoryId: string): Promise<RemoteState> {
  const tracks = await new Tracks(credentials).list(repositoryId);
  const { versions } = await import("./api.js");
  const all = await versions(repositoryId);
  const versionOfSha = new Map<string, string>();
  const shaOfVersion = new Map<string, string>();
  for (const version of all) {
    const sha = commitFromMessage(version.message);
    if (!sha) continue;
    versionOfSha.set(sha, version.id);
    shaOfVersion.set(version.id, sha);
  }
  return { tracks, versionOfSha, shaOfVersion, versionCount: all.length };
}

/**
 * The commit this branch should fork from, and the version that holds it.
 *
 * Walking the branch's own ancestry newest-first and stopping at the first
 * commit the project already has is the same answer `git merge-base` would
 * give against every pushed branch at once, without having to ask which
 * branches those are.
 */
function forkPoint(
  tip: string,
  versionOfSha: Map<string, string>,
): { sha: string; versionId: string } | null {
  const ancestry = git(["rev-list", tip])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const sha of ancestry) {
    const versionId = versionOfSha.get(sha);
    if (versionId) return { sha, versionId };
  }
  return null;
}

/*
  What this repository already imported.

  Without it every fetch rebuilds the whole history — downloading every file of
  every version — to discover one new commit. `git fast-import` will remember
  its marks across runs if asked, so the only missing piece is our own note of
  which version each mark belongs to.

  Kept under `$GIT_DIR` because it describes this clone, not the project: two
  clones import independently and must not share a mark table.
*/
type Marks = {
  /** Where fast-import reads and writes its own mark table. */
  file: string;
  /** Version id to the mark number holding its commit. */
  ofVersion: Map<string, number>;
  /** Mark number to the git commit id fast-import gave it. */
  sha: Map<number, string>;
  dir: string;
};

async function readMarks(): Promise<Marks | null> {
  let gitDir: string;
  try {
    gitDir = git(["rev-parse", "--absolute-git-dir"]).trim();
  } catch {
    return null;
  }
  if (!gitDir) return null;
  const dir = path.join(gitDir, "coderook");
  const marks: Marks = {
    file: path.join(dir, "marks"),
    ofVersion: new Map(),
    sha: new Map(),
    dir,
  };
  try {
    const table = await readFile(path.join(dir, "versions"), "utf8");
    for (const line of table.split("\n")) {
      const [versionId, mark] = line.trim().split(/\s+/);
      if (versionId && mark) marks.ofVersion.set(versionId, Number(mark));
    }
  } catch {
    // No table yet. Every version is new, which is correct for a clone.
  }
  try {
    const table = await readFile(marks.file, "utf8");
    for (const line of table.split("\n")) {
      const match = line.trim().match(/^:(\d+)\s+([0-9a-f]{40})$/);
      if (match) marks.sha.set(Number(match[1]), match[2]!);
    }
  } catch {
    // Likewise.
  }

  /*
    Drop any version whose mark no object ever got.

    The two files are written by different things at different moments, so a
    run that dies between them leaves a version claiming a mark that names
    nothing. Believing it is the worst outcome available: the next fetch
    reports the project already imported and hands back an empty history,
    silently, with no error to notice. Cross-checking here makes a half-write
    cost a re-import instead of a wrong answer.
  */
  for (const [versionId, mark] of [...marks.ofVersion]) {
    if (!marks.sha.has(mark)) marks.ofVersion.delete(versionId);
  }
  return marks;
}

async function writeMarks(marks: Marks): Promise<void> {
  await mkdir(marks.dir, { recursive: true });
  const body = [...marks.ofVersion]
    .map(([versionId, mark]) => `${versionId} ${mark}`)
    .join("\n");
  await writeFile(path.join(marks.dir, "versions"), `${body}\n`, "utf8");
}

/**
 * Record commits this repository *pushed* in the same table imports use.
 *
 * Without this, pushing and fetching keep separate ideas of what a version is.
 * A repository that pushes gets a tracking ref pointing at its own commits; a
 * later fetch rebuilds those same versions as new commits with new ids, and
 * git refuses to move the ref because the two histories share no ancestor:
 *
 *   not updating refs/coderook/main (new tip … does not contain …)
 *
 * Writing the pushed commits here means a later import recognises those
 * versions as already present, skips them, and hangs anything new off the
 * commit that is genuinely in this repository. One identity space, both ways.
 *
 * The fast-import marks file is written directly rather than left to
 * fast-import, because no import ran — the objects are already here.
 */
async function recordPushedCommits(marks: Marks): Promise<void> {
  await mkdir(marks.dir, { recursive: true });
  const table = [...marks.sha]
    .sort(([left], [right]) => left - right)
    .map(([mark, sha]) => `:${mark} ${sha}`)
    .join("\n");
  await writeFile(marks.file, table ? `${table}\n` : "", "utf8");
  await writeMarks(marks);
}

/**
 * Rebuild a git history from a project's versions and write it to stdout as a
 * fast-import stream.
 *
 * Each version becomes one commit holding that version's complete file list,
 * stated with `deleteall` followed by every path. Emitting a delta instead
 * would be smaller and would mean tracking what the previous commit held on
 * every branch of the graph; restating the tree is bounded work per commit and
 * cannot drift.
 *
 * Contents are deduplicated by SHA-256 across the whole history, so a file
 * unchanged across a thousand versions is downloaded and sent to git once.
 */
/*
  How many blobs a clone fetches at once, and how much it will hold doing it.

  Eight lanes for the same reason the folder walks use eight: these are
  latency, not work, and the measured curve flattens there. The byte ceiling
  is what stops a window of large files becoming a window of memory — one
  oversized file still goes through on its own, because the count check comes
  first and an empty window always accepts one more.
*/
const BLOB_LANES = 8;
/** Fewer new files than this, and one request for them each is quicker. */
const ARCHIVE_MIN_FILES = 64;
/** The share of a version's bytes that must be new before it is fetched whole. */
const ARCHIVE_MIN_SHARE = 0.5;
const BLOB_WINDOW_BYTES = 64 * 1024 * 1024;

async function doImport(
  refs: string[],
  url: string,
  /** From `git clone --depth N`; only honoured on a first import. */
  depth: number | null = null,
): Promise<void> {
  const { owner, slug } = parseRemoteUrl(url);
  const project = await findProject(owner ? `${owner}/${slug}` : slug);
  if (!project) {
    say(
      `No CodeRook project called "${owner ? `${owner}/${slug}` : slug}",` +
        " or you cannot read it.",
    );
    /*
      `done` closes the stream cleanly, but git reads "no refs" as "an empty
      repository" and reports success — so a clone of something that is not
      there made an empty folder and exited zero. Saying so on the way out is
      what turns that into a failure the person can see.
    */
    send("done");
    throw new ImportFailed(
      `No CodeRook project called "${owner ? `${owner}/${slug}` : slug}", or you cannot read it.`,
    );
  }
  const repositoryId = project.id;
  const state = await remoteState(repositoryId);
  const { versions } = await import("./api.js");
  const all = await versions(repositoryId);

  const wanted = new Map<string, string>();
  for (const ref of refs) {
    const branch = branchOf(ref);
    if (!branch) continue;
    const track = state.tracks.find(
      (candidate) => candidate.name === branch && candidate.kind === "line",
    );
    if (track?.headVersionId) wanted.set(ref, track.headVersionId);
    else say(`  no line called "${branch}" on ${slug}`);
  }
  if (!wanted.size) {
    send("done");
    return;
  }

  const order = versionsInOrder([...wanted.values()], all);
  const marks = await readMarks();

  /** SHA-256 of the contents to the fast-import mark already carrying it. */
  const blobMark = new Map<string, number>();
  /** Version id to the mark of the commit built from it. */
  const commitMark = new Map<string, number>(marks?.ofVersion ?? []);
  /*
    Numbering continues above every mark this repository already holds.
    Restarting at 1 would hand a new commit a mark that already names a
    different object, and fast-import would happily believe us.
  */
  let nextMark = 1;
  for (const mark of commitMark.values()) nextMark = Math.max(nextMark, mark + 1);

  /*
    What this import takes, out of everything the heads can reach.

    Never history an earlier shallow clone left out: its first ordinary fetch
    would otherwise bring the lot in as a second line of commits. And on a
    first import with `--depth`, only that many generations of each line.
  */
  const leftOut = historyLeftOut(all, commitMark.keys());
  let chosen = order.filter((version) => !leftOut.has(version.id));
  if (depth && depth > 0) {
    if (commitMark.size) {
      say(`  --depth applies to a new clone; fetching everything newer than what is here.`);
    } else {
      const keep = withinDepth([...wanted.values()], all, depth);
      chosen = chosen.filter((version) => keep.has(version.id));
      say(
        `Taking the newest ${depth} version${depth === 1 ? "" : "s"} of each line ` +
          `(--depth ${depth}); ${order.length - chosen.length} older left out.`,
      );
    }
  }

  /*
    Point every ref git asked for at the commit its line's head became.

    Which ref needs what is worked out in `refPlacements`; this only says it.
    `reset` is idempotent, so naming a ref that a commit in this stream has
    already set costs a line and changes nothing.
  */
  const settleRefs = () => {
    const { placed, unplaceable } = refPlacements(wanted, commitMark);
    for (const { ref, mark } of placed) {
      send(`reset ${importRef(ref)}`);
      send(`from :${mark}`);
    }
    for (const ref of unplaceable) {
      say(`  could not place ${ref}: no commit for its head version`);
    }
  };

  const fresh = chosen.filter((version) => !commitMark.has(version.id));
  if (!fresh.length) {
    say(`Already up to date with ${slug}.`);
    /*
      Still has to name the refs. "Nothing new to fetch" and "this ref does
      not exist" are different answers, and a line added since the last fetch
      is the first case while looking like the second.

      The marks table is loaded first because the refs are placed by mark,
      and without it those marks name nothing in this stream.
    */
    if (marks) {
      send("feature done");
      send(`feature import-marks-if-exists=${marks.file.replaceAll("\\", "/")}`);
      send(`feature export-marks=${marks.file.replaceAll("\\", "/")}`);
      settleRefs();
    }
    send("done");
    return;
  }
  say(
    `Importing ${fresh.length} version${fresh.length === 1 ? "" : "s"} from ${slug}` +
      (chosen.length > fresh.length
        ? ` (${chosen.length - fresh.length} already here)`
        : "") +
      ".",
  );

  const { Downloader } = await import("../../cbx/src/core/download.js");
  const downloader = new Downloader(credentials);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "coderook-fetch-"));

  try {
    send("feature done");
    if (marks) {
      /*
        `-if-exists` because the first import has no file yet, and plain
        `import-marks` is a hard error when the file is missing.
      */
      send(`feature import-marks-if-exists=${marks.file.replaceAll("\\", "/")}`);
      send(`feature export-marks=${marks.file.replaceAll("\\", "/")}`);
    }

    let done = 0;
    for (const version of fresh) {
      const files = await downloader.files(repositoryId, version.id);

      /*
        Blobs first: fast-import requires a mark to exist before a commit
        names it. Fetched a window at a time and written out in order.

        This asked for one file, waited for it, wrote it to a scratch path,
        read it back, and only then asked for the next — so a clone cost one
        network round trip per file, in series. Against a 21,071-file project
        that is 21,071 round trips at about seven tenths of a second each,
        and a clone that never finished: measured over twenty seconds it was
        using 0.17s of processor and moving two kilobytes.

        The stream fast-import reads has to stay ordered, so the fetching is
        what overlaps, not the writing. The window is bounded by count and by
        bytes together, because sixteen source files and sixteen video files
        are not the same amount to be holding at once.
      */
      /* Only content not already imported: a blob is written once, by digest. */
      const seenBlob = new Set<string>();
      const wantedBlobs = files.filter((file) => {
        if (blobMark.has(file.sha256) || seenBlob.has(file.sha256)) return false;
        seenBlob.add(file.sha256);
        return true;
      });

      /*
        The whole version in one request — but only when most of it is new.

        The archive is every file the version holds, and this used to fetch it
        for every version and then keep only the files not already imported.
        After the first, that is nearly none of them: a five-version clone of
        a large project downloaded its whole snapshot five times over to use
        the changed files out of each, which is why an archive added to speed
        clones up left one taking eighty-two minutes.

        So it is weighed per version: where the files still wanted are at
        least half of the version's bytes, one request for the lot wins; where
        they are a handful, fetching just those does. Below a few dozen files
        the round trips are not worth avoiding at all.

        Where it is worth it, fetching per file would be one round trip each:
        21,071 of them on a real Unity project, four hours in series and about
        half an hour even eight at a time.

        Anything unexpected about the archive — an entry this cannot read, a
        short download, a service that does not offer the route — falls
        through to the per-file path below, which is slow and known to work.
        A clone that is slow is a nuisance; a clone that writes the wrong bytes
        is not recoverable by trying again.
      */
      const bytesOf = (list: typeof files) =>
        list.reduce((sum, file) => sum + Number(file.sourceSize ?? 0), 0);
      const archiveWorthIt =
        wantedBlobs.length >= ARCHIVE_MIN_FILES &&
        bytesOf(wantedBlobs) >= bytesOf(files) * ARCHIVE_MIN_SHARE;
      const fromArchive = new Map<string, Uint8Array>();
      if (archiveWorthIt) try {
        const packed = await downloader.archive(repositoryId, version.id);
        for (const entry of readStoredZip(packed)) {
          fromArchive.set(entry.path, entry.bytes);
        }
      } catch (error) {
        /*
          Said out loud, not swallowed.

          This fell back silently, and the silence cost an hour: a deadline
          meant for ordinary requests was aborting the archive, the import
          dropped to fetching every file on its own, and from the outside it
          looked exactly like the slow clone the archive was added to fix.
          A fallback nobody can see is a fallback nobody can diagnose.
        */
        say(
          `  the archive for v${version.sequence} could not be used ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            `fetching its files one by one`,
        );
        fromArchive.clear();
      }


      for (let at = 0; at < wantedBlobs.length; ) {
        const window: (typeof files)[number][] = [];
        let held = 0;
        while (at < wantedBlobs.length && window.length < BLOB_LANES) {
          const size = Number(wantedBlobs[at]!.sourceSize ?? 0);
          if (window.length > 0 && held + size > BLOB_WINDOW_BYTES) break;
          held += size;
          window.push(wantedBlobs[at]!);
          at += 1;
        }

        const fetched = await Promise.all(
          window.map(async (file, lane) => {
            /* Already in hand, if the archive carried it. */
            const packed = fromArchive.get(file.path);
            if (packed) return { file, bytes: packed };
            /*
              A scratch path per lane. They shared one name, which is fine
              while only one download is ever in flight and silently wrong
              the moment two are.
            */
            const target = path.join(scratch, `blob-${lane}.bin`);
            await rm(target, { force: true });
            await downloader.fileTo(repositoryId, version.id, file, target);
            return { file, bytes: await readFile(target) };
          }),
        );

        for (const { file, bytes } of fetched) {
          const mark = nextMark++;
          blobMark.set(file.sha256, mark);
          send("blob");
          send(`mark :${mark}`);
          send(`data ${bytes.length}`);
          process.stdout.write(bytes);
          process.stdout.write("\n");
        }
      }

      const mark = nextMark++;
      commitMark.set(version.id, mark);
      marks?.ofVersion.set(version.id, mark);
      const ref =
        [...wanted.entries()].find(([, head]) => head === version.id)?.[0] ??
        `refs/heads/${state.tracks.find((track) => track.headVersionId === version.id)?.name ?? "main"}`;

      const parents = version.parentVersionIds
        .map((parent) => commitMark.get(parent))
        .filter((value): value is number => value !== undefined);

      const author = version.authorName || "CodeRook";
      const when = `${stamp(version.createdAt)} +0000`;
      const message =
        messageWithoutMarker(version.message) || `Version ${version.sequence}`;
      const body = Buffer.from(message, "utf8");

      send(`commit ${importRef(ref)}`);
      send(`mark :${mark}`);
      /*
        No email is invented. CodeRook records who published a version, not an
        address, and a plausible-looking address that belongs to nobody is
        worse than an obviously synthetic one: it survives being copied into a
        mailing list or a CONTRIBUTORS file.
      */
      send(`author ${identity(author)} <noreply@coderook.com> ${when}`);
      send(`committer ${identity(author)} <noreply@coderook.com> ${when}`);
      send(`data ${body.length}`);
      process.stdout.write(body);
      process.stdout.write("\n");
      if (parents[0] !== undefined) send(`from :${parents[0]}`);
      for (const extra of parents.slice(1)) send(`merge :${extra}`);
      send("deleteall");
      for (const file of files) {
        /*
          Never into git's own directory. Git would refuse to check one out,
          but it would sit in the history of every clone; new versions cannot
          hold one, and this keeps older ones from carrying it into git.
        */
        if (file.path.split("/").some(isGitDirectoryName)) continue;
        send(
          `M ${file.executable ? "100755" : "100644"} :${blobMark.get(file.sha256)} ${quotePath(file.path)}`,
        );
      }
      send("");

      done += 1;
      if (done % 10 === 0 || done === fresh.length) {
        say(`  ${done}/${fresh.length} versions`);
      }
    }

    /*
      What each save says about itself, as git notes.

      A CodeRook save carries a description separate from its message — the
      thing the website shows as release info and `cbx notes` writes — and a
      fetch used to drop all of it except on the few versions that were also
      releases. Git's answer for text attached to a commit without changing
      the commit is a note, so that is where it goes: `git log
      --notes=coderook` shows them, and pushing them back returns them.

      Written as one commit on its own ref after every version commit exists,
      because a note has to name a commit that is already in the stream.
    */
    const described = fresh.filter((version) => (version.notes ?? "").trim());
    if (described.length) {
      send(`commit ${importRef(NOTES_REF)}`);
      send(
        `committer CodeRook <noreply@coderook.com> ` +
          `${stamp(new Date().toISOString())} +0000`,
      );
      const why = Buffer.from("What each save says about itself\n", "utf8");
      send(`data ${why.length}`);
      process.stdout.write(why);
      process.stdout.write("\n");
      for (const version of described) {
        const mark = commitMark.get(version.id);
        if (mark === undefined) continue;
        const body = Buffer.from(`${(version.notes ?? "").trim()}\n`, "utf8");
        send(`N inline :${mark}`);
        send(`data ${body.length}`);
        process.stdout.write(body);
        process.stdout.write("\n");
      }
      say(`  ${described.length} description${described.length === 1 ? "" : "s"} as git notes`);
    }

    /* Every ref git asked for, named outright now the commits exist. */
    settleRefs();

    /*
      Releases come back as tags, because that is the same statement in the
      other vocabulary: a version somebody gave a name to.

      Emitted after every commit, so the mark a tag points at is certain to
      exist. A release naming a version outside the branches being imported is
      skipped rather than guessed at — the tag would have nothing to point to.
    */
    try {
      const { releases } = await import("./api.js");
      const named = await releases(repositoryId);
      let tagged = 0;
      for (const release of named) {
        const mark = commitMark.get(release.versionId);
        if (mark === undefined) continue;
        const body = Buffer.from(release.notes || release.name, "utf8");
        const tagName = release.name.replace(/[\s~^:?*[\\\x00-\x1f]/g, "-");
        if (!tagName || tagName.startsWith("-") || tagName.includes("..")) continue;
        send(`tag ${tagName}`);
        send(`from :${mark}`);
        send(
          `tagger ${identity(release.releasedBy || "CodeRook")} <noreply@coderook.com> ` +
            `${stamp(release.releasedAt)} +0000`,
        );
        send(`data ${body.length}`);
        process.stdout.write(body);
        process.stdout.write("\n");
        tagged += 1;
      }
      if (tagged) say(`  ${tagged} release${tagged === 1 ? "" : "s"} as tags`);
    } catch (error) {
      // A project whose releases cannot be read is still worth importing.
      say(`  could not read releases: ${(error as Error).message}`);
    }

    send("done");
    /*
      Written after the stream, not during. fast-import only writes its own
      mark file when it finishes, so a table saved earlier would name marks
      that no object ever got — and the next fetch would build commits whose
      parents do not exist.
    */
    if (marks) await writeMarks(marks);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function doPush(
  requests: PushRequest[],
  url: string,
): Promise<void> {
  /*
    A push never goes to the account named in the URL — it goes to the one the
    token belongs to. Publishing somebody's work to a different account on
    their behalf would be the worse mistake of the two.

    But it is not enough to ignore the name, now that fetching honours it.
    The same URL would then read from one account and write to another: a
    push to `coderook://somebody/their-project` quietly made a private
    project of that name on your own account and reported success, while git
    printed "To coderook://somebody/their-project". Saying no is the honest
    answer, and it leaves the person a working one.
  */
  const { owner, slug } = parseRemoteUrl(url);
  if (owner) {
    const me = await whoami().catch(() => null);
    const mine = (me?.username ?? "").toLowerCase();
    if (mine && owner.toLowerCase() !== mine) {
      say(
        `This remote names ${owner}, and you are signed in as ${mine}.` +
          ` A push goes to your own account, so it would land somewhere the` +
          ` URL does not name.`,
      );
      say(`To publish your own copy: git remote set-url origin coderook://${mine}/${slug}`);
      for (const request of requests) {
        send(`error ${request.dst} this remote belongs to ${owner}, not to ${mine}`);
      }
      send("");
      return;
    }
  }
  const marks = await readMarks();

  /*
    Re-read the project before every ref, not once before the batch.

    `git push --all` sends every branch in one batch, and the first of them
    routinely creates the project. Reading the state once meant every later
    ref in that same push still believed the project did not exist: it
    published against a null repository, started its history from nothing, and
    left its line without a head. Pushing two branches to a new project
    produced one working line and one empty one, and reported success for
    both — which is the shape a whole-repository transfer takes, so it failed
    exactly where it mattered most.

    One extra listing per ref. A push carries a handful of refs and each one
    publishes versions costing seconds, so the cost is not worth the class of
    bug avoiding it creates.
  */
  let repositoryId: string | null = (await findProject(slug))?.id ?? null;
  let state: RemoteState | null = repositoryId
    ? await remoteState(repositoryId)
    : null;
  const refreshProject = async () => {
    if (!repositoryId) repositoryId = (await findProject(slug))?.id ?? null;
    state = repositoryId ? await remoteState(repositoryId) : null;
  };
  const knownRefs = () => {
    const found = new Map<string, string>();
    for (const track of state?.tracks ?? []) {
      if (track.kind !== "line" || !track.headVersionId) continue;
      const sha = headCommit(track.headVersionId, state!, marks);
      if (sha) found.set(`refs/heads/${track.name}`, sha);
    }
    return found;
  };
  let known = knownRefs();

  let nextPushMark = 1;
  for (const mark of marks?.sha.keys() ?? []) {
    nextPushMark = Math.max(nextPushMark, mark + 1);
  }

  const uploader = new Uploader(credentials);
  const catFile = new CatFile();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "coderook-push-"));
  let warnedAboutMerges = false;

  try {
    for (const request of ordered(requests)) {
      /*
        Whatever the previous ref did, this one starts from what the project
        actually holds now — including a project the previous ref created.
      */
      await refreshProject();
      known = knownRefs();

      /*
        A tag names a version, which is exactly what a CodeRook release is:
        "a Version with a name on it, not a different kind of object". So a tag
        does not publish anything — it finds the version the tagged commit
        already became and gives it that name. Pushing a tag for a commit that
        was never pushed is refused rather than guessed at.
      */
      const tag = tagOf(request.dst);
      if (tag) {
        if (!request.src) {
          send(`error ${request.dst} deleting a tag is not supported`);
          continue;
        }
        if (!state) {
          send(`error ${request.dst} push a branch before tagging it`);
          continue;
        }
        const target = git(["rev-list", "-n", "1", request.src]).trim();
        const versionId = state.versionOfSha.get(target);
        if (!versionId) {
          send(
            `error ${request.dst} commit ${target.slice(0, 8)} has not been pushed to CodeRook yet`,
          );
          say(`\n  Push the branch first, then push the tag.\n`);
          continue;
        }
        /*
          An annotated tag carries a message and a lightweight one does not.
          `for-each-ref` gives the annotation only for the former, and reading
          the commit's message instead would put the commit text on the
          release, which is a different thing that happens to be nearby.
        */
        /*
          Only an annotated tag has a message of its own. `%(contents)` on a
          lightweight tag falls through to the commit it points at, so asking
          for it unconditionally puts the commit's message on the release —
          text nobody wrote about the release, presented as release notes.

          `%(objecttype)` separates the two: `tag` for an annotated one, and
          `commit` for a lightweight tag, which points straight at the commit
          and carries nothing.
        */
        const described = git([
          "for-each-ref",
          "--format=%(objecttype)%0a%(contents)",
          request.dst,
        ]);
        const newline = described.indexOf("\n");
        const kind = (newline === -1 ? described : described.slice(0, newline)).trim();
        const notes =
          kind === "tag" && newline !== -1 ? described.slice(newline + 1).trim() : "";
        try {
          const { markRelease, releases } = await import("./api.js");
          /*
            A version carries one name, so two tags on the same commit cannot
            both survive — the second renames the release the first made. Git
            allows it and CodeRook cannot represent it, and quietly dropping a
            release somebody just published is the wrong way to find that out.
          */
          const existing = await releases(repositoryId!).catch(() => []);
          const already = existing.find(
            (release) => release.versionId === versionId && release.name !== tag,
          );
          if (already) {
            say(
              `  note: v${already.sequence} was already released as "${already.name}".
` +
                `        A version carries one name, so it is now "${tag}".`,
            );
          }
          await markRelease(repositoryId!, versionId, tag, notes || null);
          send(`ok ${request.dst}`);
          say(`  released "${tag}" at ${target.slice(0, 8)}`);
        } catch (error) {
          send(
            `error ${request.dst} ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }

      const branch = branchOf(request.dst);
      if (!branch) {
        send(`error ${request.dst} only branches and tags can be pushed to CodeRook`);
        continue;
      }
      if (!request.src) {
        send(`error ${request.dst} deleting a branch is not supported; CodeRook versions are immutable`);
        continue;
      }
      /*
        Refused rather than quietly treated as an ordinary push. A force push
        means "make the remote match me, discarding what is there", and a
        published version cannot be unpublished — so the one thing the person
        asked for is the one thing that cannot happen. Accepting it and
        appending instead would be a different operation wearing its name.
      */
      if (request.force) {
        send(
          `error ${request.dst} force pushing is not supported; published versions are immutable and cannot be discarded`,
        );
        continue;
      }

      const tip = git(["rev-parse", request.src]).trim();
      const already = known.get(request.dst);
      if (already === tip) {
        send(`ok ${request.dst}`);
        say(`  ${branch}: already up to date`);
        continue;
      }

      /*
        Refuse a push that is not a fast-forward, the way git itself does.

        Left alone, the publish still succeeds: the service notices the
        divergence, keeps both sides and opens a merge track. That is the right
        behaviour for the desktop app and exactly the wrong end state here,
        because the person is standing in git and a merge track is not
        something git can see, let alone resolve — they would be told the push
        failed while their work sat in a queue that only `cbx merge` can
        empty.

        Rejecting first keeps the whole loop inside git: pull, merge, push.
        Nothing is uploaded, so there is nothing stranded to clean up.
      */
      if (already) {
        if (!gitOk(["cat-file", "-e", `${already}^{commit}`])) {
          send(
            `error ${request.dst} the remote has commit ${already.slice(0, 8)}, which this repository does not have; run "git fetch" first`,
          );
          continue;
        }
        if (!gitOk(["merge-base", "--is-ancestor", already, tip])) {
          send(
            `error ${request.dst} non-fast-forward; the remote has work you do not have locally`,
          );
          say(
            `\n  Someone published to "${branch}" since you last fetched.\n` +
              `    git pull --rebase coderook ${branch}\n` +
              `  then push again. Nothing was uploaded.\n`,
          );
          continue;
        }
      }

      /*
        A project whose versions cannot be tied to any commit is refused
        rather than appended to. Those versions are real work — published from
        the desktop app, the CLI or an import — and replaying a git history on
        top of them would interleave two unrelated sequences with no way back.

        The test is whether the project came from git *at all*, not whether
        this particular branch is known. Checking the branch instead refuses
        the ordinary act of pushing a second branch to a project git already
        owns, which is the common case and not a conflict of any kind.
      */
      if (state && !already && state.versionCount > 0 && state.versionOfSha.size === 0) {
        send(
          `error ${request.dst} the project "${slug}" already has ${state.versionCount} version${state.versionCount === 1 ? "" : "s"} that did not come from git; pushing would publish this history a second time`,
        );
        say(
          `\n  Push to a new project instead:\n` +
            `    git remote set-url coderook coderook://<a-new-name>\n`,
        );
        continue;
      }

      /*
        A branch the project has never seen starts at the newest commit it
        *has* seen — its fork point — rather than at the project head. Starting
        a track at the head would give the branch every change made on the
        line it forked away from, which is precisely the work the person
        branched to avoid.
      */
      let fork: { sha: string; versionId: string } | null = null;
      if (!already && state && state.versionOfSha.size > 0) {
        fork = forkPoint(tip, state.versionOfSha);
      }

      const from = already ?? fork?.sha ?? null;
      const range = from ? `${from}..${tip}` : tip;
      const commits = git(["rev-list", "--reverse", "--topo-order", range])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (!commits.length) {
        /*
          Nothing to publish does not mean nothing to do. A branch whose tip
          the project already holds — one merged into another branch, most
          often — still has to exist as a line, or the push reports a new
          branch that is not there and the next push agrees it is up to date.
        */
        if (!already && fork && repositoryId) {
          try {
            await new Tracks(credentials).create(
              repositoryId,
              branch,
              fork.versionId,
            );
            say(`  created line "${branch}" at ${fork.sha.slice(0, 8)} (already published)`);
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (!TRACK_EXISTS.test(text)) {
              send(`error ${request.dst} ${text}`);
              continue;
            }
          }
        }
        send(`ok ${request.dst}`);
        continue;
      }

      /*
        Said before the work starts, not after. Each commit becomes a save on
        the project and saves are not free to make, so somebody pushing years
        of history deserves the chance to stop and import a snapshot instead.

        "to publish as versions" is what this used to say, and it stopped
        being true when commits and versions separated: a pushed commit is a
        save that nobody outside the project can see. Publishing one is what
        pushing a *tag* does, because a tag is a name and a named save is a
        version.
      */
      const estimate = Math.round((commits.length * 11) / 60);
      say(
        `  ${commits.length} commit${commits.length === 1 ? "" : "s"} to send as save${commits.length === 1 ? "" : "s"}` +
          (commits.length > 20 ? ` — roughly ${estimate} minute${estimate === 1 ? "" : "s"}` : ""),
      );

      /*
        A push that continues a branch has to start from where the branch
        actually is, in three separate senses, and getting any one of them
        wrong fails differently:

        - `previous` is the commit the remote already holds. Diffing from the
          empty tree instead would mark every file as added and republish the
          whole project as though it were new.
        - `baseVersionId` is the version this publish is based on. Sending
          null claims the project is empty, and the service correctly refuses
          rather than laying this history over somebody's work.
        - `local`/`known` is what the remote holds now. Without it, a file
          present in the version but not in our scratch tree is
          indistinguishable from one this push deleted — and the service would
          drop it.
      */
      let baseVersionId: string | null = null;
      let manifest: Record<string, string> = {};
      let local: Record<string, string> = {};
      let previous = EMPTY_TREE;
      let currentRepositoryId = repositoryId;
      let published = 0;

      if (from && repositoryId && state) {
        previous = from;
        if (already) {
          const track = state.tracks.find(
            (candidate) => candidate.name === branch && candidate.kind === "line",
          );
          if (!track?.headVersionId) {
            send(`error ${request.dst} could not read the current head of "${branch}"`);
            continue;
          }
          baseVersionId = track.headVersionId;
        } else if (fork) {
          /*
            The track has to exist before anything can be published onto it,
            and it has to start at the fork point. `create` is allowed to fail
            with "already exists" — another push may have made it — in which
            case the existing one is what we wanted anyway.
          */
          baseVersionId = fork.versionId;
          try {
            await new Tracks(credentials).create(
              repositoryId,
              branch,
              fork.versionId,
            );
            say(`  created line "${branch}" from ${fork.sha.slice(0, 8)}`);
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (!TRACK_EXISTS.test(text)) throw error;
          }
        }

        const { Downloader } = await import(
          "../../cbx/src/core/download.js"
        );
        const held = await new Downloader(credentials).files(
          repositoryId,
          baseVersionId!,
        );
        manifest = Object.fromEntries(held.map((file) => [file.path, file.sha256]));
        local = { ...manifest };
      }

      for (const sha of commits) {
        const parents = git(["rev-list", "--parents", "-n", "1", sha])
          .trim()
          .split(/\s+/)
          .slice(1);
        if (parents.length > 1 && !warnedAboutMerges) {
          warnedAboutMerges = true;
          say(
            `  note: a merge commit arrives as one save holding the merged ` +
              `tree.\n        The contents are exact; the branch shape is not kept.`,
          );
        }

        const changes = await applyCommit(catFile, scratch, previous, sha);
        previous = sha;
        if (changes.skipped.length) {
          say(`  skipped ${changes.skipped.length} submodule path(s) in ${sha.slice(0, 8)}`);
        }
        if (!changes.written.length && !changes.deleted.length) {
          // An empty commit, or one that only touched submodules. Nothing to
          // publish, but the ref still has to end up pointing at it.
          published += 1;
          continue;
        }

        const subject = git(["log", "-1", "--format=%B", sha]).trim();
        /*
          Built by the shared description rather than assembled here. Every
          sharp edge in that contract — deletions in both lists, `known`,
          compare-and-swap on the base version — was learned once by
          `cbx submit` and then learned again here, as a bug.
        */
        const uploadRequest = uploadRequestFor({
          localPath: scratch,
          changed: changes.written,
          deleted: changes.deleted,
          message: messageWithCommit(subject || `Commit ${sha.slice(0, 8)}`, sha),
          projectName: slug,
          repositoryId: currentRepositoryId,
          baseVersionId,
          track: branch,
          allowIgnored: true,
          executable: changes.executable,
          ...(Object.keys(manifest).length ? { known: local } : {}),
        });

        let result;
        try {
          const plan = await uploader.plan(uploadRequest, () => {});
          result = await uploader.execute(uploadRequest, plan, () => {});
        } catch (error) {
          const failure = classifyPublishFailure(error);
          if (failure?.kind === "interrupted") {
            /*
              Said rather than left to be assumed. The service records the
              attempt, so pushing again is answered with the version it
              already made — somebody not told this will assume the push half
              happened and go looking for a way to undo it.
            */
            send(
              `error ${request.dst} the connection failed part way through`,
            );
            say(
              `
  ${published} of ${commits.length} commits were published.
` +
                `  Push again — commits already published are not sent twice.
`,
            );
            throw error;
          }
          if (failure?.kind === "credentials") {
            /*
              The one refusal a push cannot answer. `cbx submit` can ask and
              be told yes; git has nowhere to put that question, so the way
              through is to take the key out — which is the better answer
              anyway.
            */
            send(`error ${request.dst} this commit carries a credential`);
            say(`
  ${failure.message}
`);
            /*
              Deleting the file in a later commit does not help, and saying
              "take it out and commit again" sends people in circles: a push
              publishes every commit as its own version, so the commit that
              introduced the key still carries it however many commits follow.
              The history has to lose it.
            */
            say(
              `  A later commit that deletes it is not enough — every commit` +
                ` being pushed
  becomes a version, and the one that added` +
                ` the key still carries it.
` +
                `  Rewrite it out (git rebase -i, or git commit --amend if it` +
                ` is the last one),
  or publish this deliberately with` +
                ` cbx submit --allow-secrets.
`,
            );
            /*
              Reported already, and in more detail than the wrapper can. The
              marker stops the bin printing the same paragraph a second time.
            */
            throw new AlreadyReported(failure.message);
          }
          if (failure?.kind === "conflict") {
            send(
              `error ${request.dst} somebody published to "${branch}" while this push was running`,
            );
            say(`
  git fetch, then push again.
`);
            throw error;
          }
          throw error;
        }
        if (result.mergeTrack) {
          send(
            `error ${request.dst} somebody else published to "${branch}" during this push; it is waiting on a merge`,
          );
          throw new Error("push interrupted by a concurrent publish");
        }
        currentRepositoryId = result.repositoryId;
        baseVersionId = result.versionId;
        /*
          A note on the commit becomes what the version says about itself.

          CodeRook lets a save be described before anybody decides to publish
          it, and git has exactly one place for text attached to a commit
          without altering it. Sent after the publish rather than with it,
          because a note is not part of what was saved and a failure to
          record one must not fail the push.
        */
        const note = noteOn(sha);
        if (note) {
          try {
            const { changeVersion } = await import("./api.js");
            await changeVersion(result.repositoryId, result.versionId, {
              notes: note,
            });
          } catch {
            say(`  note: the description on ${sha.slice(0, 8)} could not be saved`);
          }
        }
        /*
          The version and the commit it came from are the same thing in this
          repository from here on. Recorded so a later fetch does not rebuild
          it as a second, different commit.
        */
        if (marks) {
          const mark = nextPushMark++;
          marks.ofVersion.set(result.versionId, mark);
          marks.sha.set(mark, sha);
        }
        manifest = result.manifest;
        local = result.local;
        published += 1;
        say(
          `  [${published}/${commits.length}] v${result.sequence}  ${sha.slice(0, 8)}  ${subject.split("\n")[0]!.slice(0, 48)}`,
        );
      }

      send(`ok ${request.dst}`);
    }
  } finally {
    catFile.close();
    await rm(scratch, { recursive: true, force: true });
    if (marks) await recordPushedCommits(marks);
  }
  send("");
}

/** Read stdin as lines. The push protocol is text throughout. */
async function* lines(): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at !== -1) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  }
  if (buffer.length) yield buffer;
}

export async function main(argv: string[]): Promise<number> {
  const url = argv[1] ?? argv[0] ?? "";
  /*
    The real version, not the word "git-remote". This passed its own name
    where the version belongs, so the service applied its version floor and
    refused to serve files — `git clone` failed with a demand to update to a
    release older than the one running. Push was unaffected, which is why it
    went unnoticed until a clone.
  */
  declareClient("cli", VERSION);

  const pending: PushRequest[] = [];
  const importing: string[] = [];
  /*
    Whether a fetch asked for something that is not there. Git reads "no
    refs" as "an empty repository" and reports success, so without this a
    clone of a project you cannot see left an empty folder and exited zero.
  */
  let unservable = false;
  /** `git clone --depth N`, when git passed one. */
  let depth: number | null = null;

  for await (const line of lines()) {
    const command = line.trim();

    if (command === "capabilities") {
      // `push` rather than `export`, and `import` rather than `fetch`; see the
      // note at the top of this file.
      send("import");
      send("push");
      send("refspec refs/heads/*:refs/coderook/*");
      send("option");
      send("");
      continue;
    }

    if (command.startsWith("option ")) {
      /*
        Only what is actually acted on is accepted: answering "ok" to anything
        else would make git believe a setting took effect. Depth is honoured
        by importing fewer versions; git passes it for `clone --depth`.
      */
      const [, name, value] = command.split(" ");
      if (name === "depth" && /^[1-9][0-9]*$/.test(value ?? "")) {
        depth = Number(value);
        send("ok");
      } else {
        send("unsupported");
      }
      continue;
    }

    if (command === "list" || command === "list for-push") {
      try {
        const { owner, slug } = parseRemoteUrl(url);
        const named = owner ? `${owner}/${slug}` : slug;
        const project = await findProject(named);
        /*
          A fetch of something that is not there has to say so here.

          Git asks `list` first and only asks to import the refs it is
          offered, so a project nobody can read never reaches the import at
          all — it is simply a listing with nothing in it, which git reports
          as an empty repository and calls a success. Refusing at this point
          is the only place the answer can still be "no".

          `list for-push` is exempt: pushing to a name that does not exist
          yet is how a project gets created.
        */
        if (command === "list" && !project) {
          say(`No CodeRook project called "${named}", or you cannot read it.`);
          unservable = true;
          /*
            The listing is deliberately left unterminated.

            An empty but well-formed list is a valid answer meaning "an empty
            repository", and git takes it as one: it reports success, leaves
            a folder with nothing but .git in it, and ignores whatever the
            helper exits with. Ending the conversation instead is the only
            answer git reads as a failure.
          */
          break;
        }
        if (command === "list for-push") {
          const known = await remoteRefs(project?.id ?? null);
          for (const [ref, sha] of known) send(`${sha} ${ref}`);
          send("");
          continue;
        }

        /*
          A line whose head this clone has imported before is advertised by
          its real commit id; one it has not is advertised as `?`.

          `?` is the format's way of saying "I cannot tell you", and it is the
          honest answer the first time: the git commits are built during the
          import that follows, from versions that are not git commits, so their
          ids do not exist yet. It is the wrong answer on every fetch after
          that, because git cannot then see that nothing has changed and asks
          for the history again. The mark table is what turns the second and
          later answers into real ids.
        */
        const state = project ? await remoteState(project.id) : null;
        const lines = (state?.tracks ?? []).filter(
          (track) => track.kind === "line" && track.headVersionId,
        );
        const marks = await readMarks();
        for (const track of lines) {
          const mark = marks?.ofVersion.get(track.headVersionId!);
          const sha = mark === undefined ? undefined : marks?.sha.get(mark);
          send(`${sha ?? "?"} refs/heads/${track.name}`);
        }
        /*
          Which line a clone opens on.

          The project's own default first, then the conventional names, then
          whatever has content. Looking only for `main` was wrong for a
          transferred repository: creating a project always makes an empty
          `main`, so a repository whose default is `master` ends up with a
          `main` that holds nothing — and `main` is filtered out of `lines`
          for exactly that reason, leaving HEAD to fall on whichever branch
          happened to sort first. It landed on `master` by luck rather than
          because anything chose it.
        */
        const preferred = [
          project?.defaultBranch,
          "main",
          "master",
        ].filter((name): name is string => Boolean(name));
        const head =
          preferred
            .map((name) => lines.find((track) => track.name === name))
            .find(Boolean) ?? lines[0];
        if (head) send(`@refs/heads/${head.name} HEAD`);
      } catch (error) {
        say(`Could not read the remote: ${(error as Error).message}`);
      }
      send("");
      continue;
    }

    if (command.startsWith("import ")) {
      /*
        Deduplicated. Git asks for the same ref more than once in one batch —
        observed twice for a clone, once for the branch and once resolving
        HEAD — and importing it twice would rebuild and re-send the entire
        history for no reason.
      */
      const ref = command.slice("import ".length).trim();
      if (!importing.includes(ref)) importing.push(ref);
      continue;
    }

    if (command.startsWith("push ")) {
      const spec = command.slice("push ".length);
      const force = spec.startsWith("+");
      const [src, dst] = (force ? spec.slice(1) : spec).split(":");
      pending.push({ src: src ?? "", dst: dst ?? "", force });
      continue;
    }

    if (command === "") {
      if (importing.length) {
        const batch = importing.splice(0, importing.length);
        try {
          await doImport(batch, url, depth);
        } catch (error) {
          /*
            A project that could not be found has already said so and closed
            the stream. Anything else has not, and fast-import would wait on
            a stream that never ends.
          */
          if (error instanceof ImportFailed) {
            unservable = true;
          } else {
            say(
              `Import failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            send("done");
          }
        }
        continue;
      }
      if (pending.length) {
        const batch = pending.splice(0, pending.length);
        try {
          const account = await whoami();
          say(`Pushing to CodeRook as ${account.username || account.displayName}.`);
        } catch {
          say("Not signed in. Run `cbx sign-in` first.");
          for (const request of batch) {
            send(`error ${request.dst} not signed in to CodeRook`);
          }
          send("");
          continue;
        }
        await doPush(batch, url);
      }
      continue;
    }
  }

  return unservable ? 1 : 0;
}
