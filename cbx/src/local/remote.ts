/**
 * CodeRook as a remote for a local history: `push` and `pull`.
 *
 * Each local save becomes one CodeRook save, and each CodeRook save one local
 * save, and `.cbx/remote.json` remembers which is which. The two are only
 * paired once their files are known to be identical, so a pair is a promise:
 * the save here and the version there hold exactly the same bytes.
 *
 * Neither side is overwritten. A push onto a line CodeRook has moved on is
 * refused, as git refuses one, and a pull onto local saves that were never
 * pushed fetches CodeRook's saves and says so rather than merging, because
 * merging a local history is not built yet.
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Credentials } from "../core/credentials.js";
import { Downloader, type RemoteFile, type RemoteVersion } from "../core/download.js";
import { Tracks } from "../core/tracks.js";
import { Uploader, type UploadRequest } from "../core/upload.js";
import type { UploadProgress } from "../shared/types.js";
import {
  byPath,
  compareTrees,
  headTree,
  hiddenInTheWay,
  inTheWay,
  UnsavedChanges,
  type Changes,
} from "./history.js";
import type { Repository, Save, TreeEntry } from "./repository.js";
import { checkout, readFolder, sameFile, storeFile, writeEntriesInto } from "./snapshot.js";
import { isAncestor, mergeInto, readMergeState, type MergeState } from "./merge.js";

/** The service's limit on a save's message. */
const MESSAGE_LIMIT = 240;

export type RemoteRecord = {
  repositoryId: string | null;
  /** Local save id to the CodeRook version holding the same files. */
  pairs: Record<string, string>;
};

const REMOTE_FILE = "remote.json";

export async function readRemote(repository: Repository): Promise<RemoteRecord> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(repository.directory, REMOTE_FILE), "utf8"),
    ) as Partial<RemoteRecord>;
    return { repositoryId: raw.repositoryId ?? null, pairs: raw.pairs ?? {} };
  } catch {
    return { repositoryId: null, pairs: {} };
  }
}

async function writeRemote(repository: Repository, record: RemoteRecord): Promise<void> {
  const target = path.join(repository.directory, REMOTE_FILE);
  await writeFile(`${target}.partial`, JSON.stringify(record, null, 2));
  await rename(`${target}.partial`, target);
}

/**
 * The three parts of the CodeRook client these use. Real ones by default; a
 * test passes its own so the rules here can be checked without a network.
 */
export type RemoteServices = {
  tracks: Pick<Tracks, "list" | "create">;
  uploader: Pick<Uploader, "plan" | "execute">;
  downloader: Pick<Downloader, "versions" | "files" | "collect">;
};

function servicesFor(credentials: Credentials, given?: Partial<RemoteServices>): RemoteServices {
  return {
    tracks: given?.tracks ?? new Tracks(credentials),
    uploader: given?.uploader ?? new Uploader(credentials),
    downloader: given?.downloader ?? new Downloader(credentials),
  };
}

/** CodeRook's line has saves this history does not: pull first. */
export class RemoteAhead extends Error {}

/** The version CodeRook made is not the save that was sent. */
export class RemoteDiffers extends Error {}

/** Nothing to pull from, or nothing on CodeRook under that name. */
export class NoRemote extends Error {}

function shortMessage(message: string): string {
  const flat = message.trim();
  return flat.length <= MESSAGE_LIMIT ? flat : `${flat.slice(0, MESSAGE_LIMIT - 1)}…`;
}

function digestsOf(files: Map<string, TreeEntry>): Record<string, string> {
  return Object.fromEntries([...files].map(([file, entry]) => [file, entry.sha256]));
}

function sameDigests(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** Saves from `tip` back along first parents, stopping at one `stop` accepts. */
async function unpairedChain(
  repository: Repository,
  tip: string,
  paired: (id: string) => boolean,
): Promise<{ chain: Save[]; base: Save | null }> {
  const chain: Save[] = [];
  let at: Save | null = await repository.readSave(tip);
  while (at && !paired(at.id)) {
    chain.push(at);
    const parent: string | undefined = at.parents[0];
    at = parent ? await repository.readSave(parent) : null;
  }
  return { chain: chain.reverse(), base: at };
}

/**
 * The saves from `to` (not included) up to `from`, oldest first, along the
 * shortest run of parents; null when `to` is not an ancestor of `from`.
 */
async function routeTo(repository: Repository, from: string, to: string): Promise<Save[] | null> {
  const cameFrom = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) {
      const route: Save[] = [];
      let at = cameFrom.get(id) ?? null;
      while (at) {
        route.push(await repository.readSave(at));
        at = cameFrom.get(at) ?? null;
      }
      return route;
    }
    for (const parent of (await repository.readSave(id)).parents) {
      if (!cameFrom.has(parent)) {
        cameFrom.set(parent, id);
        queue.push(parent);
      }
    }
  }
  return null;
}

/* ---- push ------------------------------------------------------------- */

export type PushEvent =
  | { kind: "save"; index: number; total: number; save: Save }
  | { kind: "upload"; progress: UploadProgress }
  | { kind: "pushed"; save: Save; versionId: string; sequence: number }
  | { kind: "unchanged"; save: Save };

export type PushResult = {
  repositoryId: string | null;
  line: string;
  pushed: Array<{ save: Save; versionId: string; sequence: number }>;
  /** The CodeRook version the line ends on, and what it holds. */
  head: { versionId: string; sequence: number; manifest: Record<string, string> } | null;
};

export async function push(
  repository: Repository,
  options: {
    credentials: Credentials;
    /** Names the project when this push creates it. */
    projectName: string;
    /** Used when this history has never pushed: the project the folder is linked to. */
    repositoryId?: string | null;
    allowSecrets?: boolean;
    acknowledged?: boolean;
    report?: (event: PushEvent) => void;
    services?: Partial<RemoteServices>;
  },
): Promise<PushResult> {
  const services = servicesFor(options.credentials, options.services);
  return repository.locked(async () => {
    const line = await repository.currentLine();
    const tip = await repository.head();
    if (!tip) throw new Error(`Nothing is saved on ${line} yet, so there is nothing to push.`);
    if (await readMergeState(repository)) {
      throw new Error("A merge is waiting on conflicts. Finish it with cbx save first, then push.");
    }
    const remote = await readRemote(repository);
    let repositoryId = remote.repositoryId ?? options.repositoryId ?? null;
    /* Pairs from another project mean nothing to this one. */
    if (options.repositoryId && remote.repositoryId && options.repositoryId !== remote.repositoryId) {
      throw new Error(
        "This history was pushed to a different CodeRook project from the one this folder is linked to.",
      );
    }

    /*
      Where CodeRook's line is now, asked before anything is sent.

      Left to itself the service would take a push onto a line that has moved
      and open a merge for it, which is right for the desktop app and wrong
      here: that merge is not something this history can see or finish.
      Refused first, the way git refuses a push that is not a fast-forward.
    */
    const versionToSave = new Map(Object.entries(remote.pairs).map(([save, version]) => [version, save]));
    const tracks = services.tracks;
    const all = repositoryId ? await tracks.list(repositoryId) : [];
    const track = all.find((one) => one.kind === "line" && one.name === line);
    let chain: Save[];
    let base: Save | null;
    let baseVersionId: string | null;
    if (track?.headVersionId) {
      const headSave = versionToSave.get(track.headVersionId);
      if (!headSave) {
        throw new RemoteAhead(
          `CodeRook's ${line} has saves this history does not. Run cbx pull, then push again. Nothing was sent.`,
        );
      }
      if (headSave === tip) return { repositoryId, line, pushed: [], head: null };
      /*
        The saves between CodeRook's head and this one, along whichever
        parents reach it. After a pull that merged, that is the merge alone:
        its first parent is local work CodeRook never had, its second is
        CodeRook's head, and the merge already holds both.
      */
      const route = await routeTo(repository, tip, headSave);
      if (!route) {
        throw new RemoteAhead(
          (await isAncestor(repository, tip, headSave))
            ? `CodeRook's ${line} is ahead of this history. Run cbx pull. Nothing was sent.`
            : `CodeRook's ${line} and this history have both moved on. Run cbx pull to merge, then push. Nothing was sent.`,
        );
      }
      chain = route;
      base = await repository.readSave(headSave);
      baseVersionId = track.headVersionId;
    } else {
      ({ chain, base } = await unpairedChain(repository, tip, (id) => id in remote.pairs));
      if (!chain.length) return { repositoryId, line, pushed: [], head: null };
      baseVersionId = base ? remote.pairs[base.id]! : null;
      if (repositoryId && !track) {
        if (baseVersionId) {
          await tracks.create(repositoryId, line, baseVersionId);
        } else if (all.some((one) => one.headVersionId)) {
          throw new RemoteAhead(
            `That CodeRook project already holds work this history does not. Pull one of its lines first. Nothing was sent.`,
          );
        }
      } else if (track) {
        /* A line that exists and is empty: the first save goes up whole. */
        base = null;
        baseVersionId = null;
      }
    }

    let before: Map<string, TreeEntry> = base
      ? byPath(await repository.readTree(base.tree))
      : new Map();
    let known: Record<string, string> | undefined = baseVersionId ? digestsOf(before) : undefined;
    const scratch = path.join(repository.directory, "push");
    const uploader = services.uploader;
    const pushed: PushResult["pushed"] = [];
    let head: PushResult["head"] = null;

    try {
      for (const [index, save] of chain.entries()) {
        options.report?.({ kind: "save", index, total: chain.length, save });
        const after = byPath(await repository.readTree(save.tree));
        const changes: Changes = compareTrees(before, after);
        const changed = [...changes.added, ...changes.modified];
        if (!changed.length && !changes.deleted.length && baseVersionId) {
          /* Holds what CodeRook already holds; nothing to make. */
          remote.pairs[save.id] = baseVersionId;
          await writeRemote(repository, { repositoryId, pairs: remote.pairs });
          options.report?.({ kind: "unchanged", save });
          before = after;
          continue;
        }

        await rm(scratch, { recursive: true, force: true });
        await writeEntriesInto(repository, scratch, changed.map((file) => after.get(file)!));
        const request: UploadRequest = {
          localPath: scratch,
          include: [...changed, ...changes.deleted],
          deletions: changes.deleted,
          message: shortMessage(save.message),
          projectName: options.projectName,
          repositoryId,
          baseVersionId,
          ...(baseVersionId ? { expectedHeadVersionId: baseVersionId } : {}),
          track: line,
          /*
            The save already applied the project's rules when it was made, and
            the scratch tree holds only what changed, so its own rules would be
            the wrong ones. The git push sends this for the same reason.
          */
          allowIgnored: true,
          /* The save's own record of what runs; on Windows the scratch tree cannot say. */
          executable: new Map([...after].map(([file, entry]) => [file, entry.executable])),
          ...(options.allowSecrets ? { allowSecrets: true } : {}),
          ...(options.acknowledged ? { acknowledged: true } : {}),
          ...(known ? { known } : {}),
        };
        const report = (progress: UploadProgress) => options.report?.({ kind: "upload", progress });
        const plan = await uploader.plan(request, report);
        const result = await uploader.execute(request, plan, report);
        if (result.mergeTrack) {
          throw new RemoteAhead(
            `Somebody saved to CodeRook's ${line} while this push was running, and it is waiting on a merge there. ` +
              `${pushed.length} of ${chain.length} saves were pushed.`,
          );
        }
        repositoryId = result.repositoryId;
        const expected = digestsOf(after);
        if (!sameDigests(result.manifest, expected)) {
          await writeRemote(repository, { repositoryId, pairs: remote.pairs });
          throw new RemoteDiffers(
            `CodeRook saved v${result.sequence}, but it does not hold the same files as ${save.id.slice(0, 10)}: ` +
              `somebody else's work was merged into it. Run cbx pull to bring it here.`,
          );
        }
        remote.pairs[save.id] = result.versionId;
        await writeRemote(repository, { repositoryId, pairs: remote.pairs });
        pushed.push({ save, versionId: result.versionId, sequence: result.sequence });
        options.report?.({ kind: "pushed", save, versionId: result.versionId, sequence: result.sequence });
        head = { versionId: result.versionId, sequence: result.sequence, manifest: result.manifest };
        baseVersionId = result.versionId;
        known = result.manifest;
        before = after;
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return { repositoryId, line, pushed, head };
  });
}

/* ---- pull ------------------------------------------------------------- */

export type PullEvent =
  | { kind: "version"; index: number; total: number; version: RemoteVersion }
  | { kind: "file"; path: string };

export type PullResult = {
  line: string;
  imported: Save[];
  /** Whether the folder and the line moved to what was pulled. */
  moved: boolean;
  /*
    Set when both sides had moved on and the pull merged them: the merge save
    when it went cleanly, or the conflicts it is waiting on.
  */
  merged?: { save?: Save; conflicts?: MergeState["conflicts"] };
  written: string[];
  removed: string[];
  head: { versionId: string; sequence: number } | null;
};

/**
 * Bring CodeRook's saves on the current line into this history, and merge
 * them with this line's own when both have moved on.
 *
 * Only files that differ from the save before are fetched; anything the
 * history already holds by digest is reused. The folder then moves the way
 * `switch` moves it: only files that changed are touched, and an unsaved edit
 * to one of those stops it.
 */
export async function pull(
  repository: Repository,
  options: {
    credentials: Credentials;
    repositoryId?: string | null;
    force?: boolean;
    report?: (event: PullEvent) => void;
    services?: Partial<RemoteServices>;
  },
): Promise<PullResult> {
  const services = servicesFor(options.credentials, options.services);
  return repository.locked(async () => {
    const line = await repository.currentLine();
    const remote = await readRemote(repository);
    const repositoryId = remote.repositoryId ?? options.repositoryId ?? null;
    if (!repositoryId) {
      throw new NoRemote(
        "This history has no CodeRook project to pull from. Push it first, or name one: cbx pull <project>.",
      );
    }
    if (options.repositoryId && remote.repositoryId && options.repositoryId !== remote.repositoryId) {
      throw new Error("This history belongs to a different CodeRook project.");
    }

    const track = (await services.tracks.list(repositoryId)).find(
      (one) => one.kind === "line" && one.name === line,
    );
    if (!track) throw new NoRemote(`CodeRook has no line called ${line} in that project.`);
    const nothing: PullResult = { line, imported: [], moved: false, written: [], removed: [], head: null };
    if (!track.headVersionId) return nothing;

    const versionToSave = new Map(Object.entries(remote.pairs).map(([save, version]) => [version, save]));
    const downloader = services.downloader;
    const listed = await downloader.versions(repositoryId);
    const byId = new Map(listed.map((version) => [version.id, version]));
    const headVersion = byId.get(track.headVersionId);
    const headSummary = headVersion ? { versionId: headVersion.id, sequence: headVersion.sequence } : null;

    /* CodeRook's saves from its head back to one this history already has. */
    const incoming: RemoteVersion[] = [];
    let at = headVersion;
    while (at && !versionToSave.has(at.id)) {
      incoming.push(at);
      const parent = at.parentVersionIds?.[0];
      at = parent ? byId.get(parent) : undefined;
    }
    incoming.reverse();
    const baseSaveId = at ? versionToSave.get(at.id)! : null;
    const localTip = await repository.head();

    /* Import, whatever happens to the folder afterwards. */
    const baseSave = baseSaveId ? await repository.readSave(baseSaveId) : null;
    let before: Map<string, TreeEntry> = baseSave
      ? byPath(await repository.readTree(baseSave.tree))
      : new Map();
    const byDigest = new Map<string, TreeEntry>();
    for (const entry of before.values()) byDigest.set(entry.sha256, entry);
    let parent = baseSave?.id ?? null;
    const imported: Save[] = [];
    const scratch = path.join(repository.directory, "pull");
    try {
      for (const [index, version] of incoming.entries()) {
        options.report?.({ kind: "version", index, total: incoming.length, version });
        const files = await downloader.files(repositoryId, version.id);
        const entries: TreeEntry[] = [];
        const fetch: RemoteFile[] = [];
        for (const file of files) {
          const was = before.get(file.path);
          const reuse = was?.sha256 === file.sha256 ? was : byDigest.get(file.sha256);
          if (reuse) {
            entries.push({
              ...reuse,
              path: file.path,
              executable: file.executable ?? was?.executable ?? reuse.executable,
            });
          } else {
            fetch.push(file);
          }
        }
        await downloader.collect(repositoryId, version.id, fetch, scratch, async (file, arrived) => {
          options.report?.({ kind: "file", path: file.path });
          let stored: { sha256: string; chunks: string[] };
          if ("bytes" in arrived) {
            const digest = await repository.objects.put(arrived.bytes);
            stored = { sha256: digest, chunks: arrived.bytes.length ? [digest] : [] };
          } else {
            stored = await storeFile(repository, arrived.path, file.sourceSize);
          }
          if (stored.sha256 !== file.sha256) throw new Error(`${file.path} did not arrive intact`);
          const entry: TreeEntry = {
            path: file.path,
            size: file.sourceSize,
            sha256: stored.sha256,
            executable: file.executable ?? before.get(file.path)?.executable ?? false,
            chunks: stored.chunks,
          };
          entries.push(entry);
          byDigest.set(entry.sha256, entry);
        });
        await repository.objects.flush();
        const tree = await repository.writeTree(entries);
        const save = await repository.writeSave({
          format: "cbx-save",
          version: 1,
          tree,
          parents: parent ? [parent] : [],
          line,
          message: version.message || `CodeRook v${version.sequence}`,
          author: version.authorName || "CodeRook",
          created: version.createdAt || new Date(0).toISOString(),
        });
        remote.pairs[save.id] = version.id;
        await writeRemote(repository, { repositoryId, pairs: remote.pairs });
        imported.push(save);
        parent = save.id;
        before = byPath(await repository.readTree(tree));
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    /*
      Where CodeRook's line ends, in this history's terms. Decided from
      ancestry rather than from what this call imported: a pull whose folder
      could not move last time has nothing new to import, and must still move.
    */
    const remoteTip = parent!;
    const stay = { line, imported, moved: false, written: [], removed: [], head: headSummary };
    if (localTip === remoteTip) return stay;
    if (localTip && (await isAncestor(repository, remoteTip, localTip))) {
      /* This history is ahead of CodeRook: saves still to push, nothing to take. */
      return stay;
    }
    if (localTip && !(await isAncestor(repository, localTip, remoteTip))) {
      /* Both sides moved on: merged, as git's pull merges. */
      const outcome = await mergeInto(repository, remoteTip, {
        message: `Merge CodeRook's ${line}`,
        author: await repository.author(),
        label: `CodeRook's ${line}`,
      });
      if (outcome.kind === "conflicts") {
        return {
          ...stay,
          written: outcome.written,
          removed: outcome.removed,
          merged: { conflicts: outcome.state.conflicts },
        };
      }
      if (outcome.kind === "up-to-date") return stay;
      return {
        ...stay,
        moved: true,
        written: outcome.written,
        removed: outcome.removed,
        merged: { save: outcome.save },
      };
    }

    /* A fast-forward: move the folder as `switch` would, then the line. */
    const { tree: savedTree } = await headTree(repository);
    const target = await repository.readTree((await repository.readSave(remoteTip)).tree);
    const reading = await readFolder(repository, { store: false, previous: savedTree });
    const saved = byPath(savedTree);
    const wanted = byPath(target);
    const touched = new Set(
      [...saved.keys(), ...wanted.keys()].filter((file) => !sameFile(saved.get(file), wanted.get(file))),
    );
    if (!options.force) {
      const blocked = [
        ...inTheWay(reading.files, saved, wanted, touched),
        ...(await hiddenInTheWay(repository, reading.files, wanted, touched)),
      ].sort();
      if (blocked.length) {
        /* The saves are here; only the folder could not move. */
        throw new UnsavedChanges(blocked, `Moving to what was pulled`);
      }
    }
    const done = await checkout(repository, reading.files, target, (file) => touched.has(file));
    await repository.setLineTip(line, remoteTip);
    return { line, imported, moved: true, ...done, head: headSummary };
  });
}
