/**
 * The lines a project is saved on, and the merges waiting on a person.
 *
 * The service has had all of this since Tracks existed: a project has one or
 * more lines of versions, and a publish that diverges from what the account
 * holds is put on a Merge Track of its own rather than laid over work the
 * uploader had not seen. That is the right behaviour and it already happens.
 *
 * What did not exist was any way to know. The app never asked for a track, so
 * a save that diverted reported "done" and said nothing about where the work
 * went — the version was safe, on a track nobody could see, and the only way
 * to find it was the website. This is the half that was missing.
 */
import { createHash } from "node:crypto";

import type { Credentials } from "./credentials.js";
import type { DesktopLabel, DesktopVersion } from "../shared/types.js";
import { clientHeaders, readRefusal } from "./identify.js";
import { RETRY_ATTEMPTS, RETRY_FIRST_WAIT_MS, pauseFor, worthRetrying } from "./retry.js";

/** One line of versions, or one merge in progress. */
export type Track = {
  id: string;
  name: string;
  /** A `line` is an ordinary branch; a `merge` is one awaiting resolution. */
  kind: "line" | "merge";
  headVersionId: string | null;
  protected: boolean;
};

/** A publish that diverged, and what it is waiting on. */
export type MergeTrack = {
  id: string;
  reference: string;
  state: "open" | "applying" | "applied" | "cancelled";
  createdAt: string;
  conflicts: { total: number; unresolved: number };
  /** Present when this is a line proposed into another, not a collided save. */
  proposal?: { from: string | null; into: string | null; title: string | null };
};

/** A proposal's review request, and where each reviewer stands. */
export type MergeRequest = {
    title: string;
    body: string | null;
    approvals: { required: number; approvals: number; changesRequestedBy: string[]; satisfied: boolean } | null;
    reviews: Array<{
      reviewerName: string | null;
      verdict: "approve" | "request_changes" | "comment";
      body: string | null;
    }>;
    requested: Array<{ displayName: string; reviewed: boolean }>;
  };

/** One path two versions disagree about. */
export type MergeConflict = {
  id: string;
  path: string;
  kind: string;
  /** Null when that side has no file, which is a deletion rather than a gap. */
  targetObjectId: string | null;
  targetSha256: string | null;
  candidateObjectId: string | null;
  candidateSha256: string | null;
  resolution: string | null;
  resolvedAt: string | null;
};

/** What something outside CodeRook reported about this merge. */
export type MergeCheck = {
  name: string;
  state: string;
  required: boolean;
  detail: string | null;
  detailsUrl: string | null;
};

export type MergeDetail = {
  track: MergeTrack;
  conflicts: MergeConflict[];
  /*
    Which versions the two sides are, so a window can read them. Both have
    always been in the reply; nothing had ever kept them, which is why the
    merge window could offer choices and never show what was being chosen
    between.
  */
  repositoryId: string;
  candidateVersionId: string | null;
  currentTargetVersionId: string | null;
  checks: MergeCheck[];
  /** Why it would not apply, separately from whether it would. */
  ready: boolean;
  unresolvedPaths: string[];
  blockedByChecks: string[];
  /** The two lines, when this is a proposal. */
  proposal: { from: string; into: string } | null;
  request: MergeRequest | null;
};

/**
 * How a person can settle one conflict.
 *
 * `edited` is the one whose content is on neither side: the file somebody
 * wrote themselves, when the answer is some of both. The service has always
 * taken it and nothing had ever sent one.
 */
export type Resolution =
  | "take_target"
  | "take_candidate"
  | "keep_both"
  | "delete"
  | "edited";

/** A media type from the name, so an edited file is stored as what it is. */
function mediaTypeForPath(path: string): string {
  const known: Record<string, string> = {
    css: "text/css",
    html: "text/html",
    js: "text/javascript",
    json: "application/json",
    md: "text/markdown",
    py: "text/x-python",
    ts: "text/typescript",
    tsx: "text/typescript",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
  };
  return known[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain";
}

/**
 * The error to raise for a failed request, with a refusal said properly.
 *
 * A build refused for being too old is not a network failure and must not
 * read like one: the person can fix it, and only if they are told how. The
 * two requests below build their own fetches rather than going through
 * `call`, so without this a refused desktop was told only "(426)".
 */
function refusalOrError(body: string, status: number, fallback: string): Error {
  const tooOld = readRefusal(status, body);
  if (tooOld) {
    return new Error(
      `${tooOld.message} You are running ${tooOld.yourVersion ?? "an older build"}; ` +
        `update from ${tooOld.upgradeUrl}.`,
    );
  }
  let message = `${fallback} (${status})`;
  if (body.trimStart().startsWith("{")) {
    try {
      message =
        (JSON.parse(body) as { error?: { message?: string } }).error?.message ??
        message;
    } catch {
      /* keep the generic message */
    }
  }
  return Object.assign(new Error(message), { status });
}

export class Tracks {
  constructor(private readonly credentials: Credentials) {}

  private async call<T>(
    route: string,
    init?: { method: string; body?: string },
  ): Promise<T> {
    let wait = RETRY_FIRST_WAIT_MS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt<T>(route, init);
      } catch (error) {
        if (attempt >= RETRY_ATTEMPTS || !worthRetrying(error)) throw error;
        await pauseFor(AbortSignal.timeout(wait * 4), wait).catch(() => undefined);
        wait *= 2;
      }
    }
  }

  private async attempt<T>(
    route: string,
    init?: { method: string; body?: string },
  ): Promise<T> {
    const token = await this.credentials.token();
    if (!token) throw new Error("Sign in again");
    const response = await fetch(`${this.credentials.origin()}${route}`, {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "CodeRook/0.1",
        ...clientHeaders(),
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `${route} failed (${response.status})`;
      if (text.trimStart().startsWith("{")) {
        try {
          message =
            (JSON.parse(text) as { error?: { message?: string } }).error
              ?.message ?? message;
        } catch {
          /* keep the generic message */
        }
      }
      throw Object.assign(new Error(message), { status: response.status });
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * A project's saves, as the owner sees them.
   *
   * Every one of them, including the ones held for review and the ones whose
   * files were taken down — this is the working history, not the published
   * one, and the whole point of showing it here is deciding what becomes
   * published.
   */
  async versions(repositoryId: string): Promise<DesktopVersion[]> {
    const body = await this.call<{ versions?: DesktopVersion[] }>(
      `/v1/repositories/${repositoryId}/versions`,
    );
    return body.versions ?? [];
  }

  /**
   * What the account says about this project, as distinct from this folder.
   *
   * The local record knows where a folder saves to and nothing about how the
   * project is published — so the history window could show which saves were
   * public without being able to say whether the project itself was, which is
   * the half that decides whether anybody can reach them.
   */
  async project(
    repositoryId: string,
  ): Promise<{ visibility: string | null }> {
    try {
      const body = await this.call<{ visibility?: string }>(
        `/v1/repositories/${repositoryId}`,
      );
      return { visibility: body.visibility ?? null };
    } catch {
      /* Not knowing is not worth failing the window for. */
      return { visibility: null };
    }
  }

  async labels(repositoryId: string): Promise<DesktopLabel[]> {
    const body = await this.call<{ labels?: DesktopLabel[] }>(
      `/v1/repositories/${repositoryId}/labels`,
    );
    return body.labels ?? [];
  }

  async createLabel(
    repositoryId: string,
    name: string,
    colour: string,
  ): Promise<DesktopLabel> {
    const body = await this.call<{ label: DesktopLabel }>(
      `/v1/repositories/${repositoryId}/labels`,
      { method: "POST", body: JSON.stringify({ name, colour }) },
    );
    return body.label;
  }

  async reviewVersion(
    repositoryId: string,
    versionId: string,
    decision: "approve" | "decline",
    note: string | null,
  ): Promise<void> {
    await this.call(`/v1/repositories/${repositoryId}/versions/${versionId}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    });
  }

  async takeVersionDown(
    repositoryId: string,
    versionId: string,
    reason: string | null,
  ): Promise<void> {
    const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    await this.call(
      `/v1/repositories/${repositoryId}/versions/${versionId}/content${query}`,
      { method: "DELETE" },
    );
  }

  /** Put the project back on an earlier save. Nothing is deleted. */
  async undo(
    repositoryId: string,
    to: string | null,
  ): Promise<{
    from: { sequence: number };
    to: { sequence: number };
    skipped: Array<{ sequence: number; name: string | null }>;
  }> {
    return await this.call(`/v1/repositories/${repositoryId}/undo`, {
      method: "POST",
      body: JSON.stringify(to ? { to } : {}),
    });
  }

  /** Publish an older save's content again, as a new save. */
  async restoreVersion(
    repositoryId: string,
    versionId: string,
    message: string,
  ): Promise<void> {
    await this.call(`/v1/repositories/${repositoryId}/versions/${versionId}/restore`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  /**
   * Everything about a version, changed in one call.
   *
   * Named, hidden, pinned or labelled from the desktop app for the first time.
   * All three clients call the same route with the same patch, which is what
   * stops the next capability being reachable from one of them and not the
   * others.
   */
  async changeVersion(
    repositoryId: string,
    versionId: string,
    patch: {
      name?: string | null;
      notes?: string | null;
      visibility?: "private" | "unlisted" | "public";
      pinned?: boolean;
      labelIds?: string[];
    },
  ): Promise<void> {
    await this.call(`/v1/repositories/${repositoryId}/versions/${versionId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /**
   * Every line and merge this project has.
   *
   * Answers an empty list rather than throwing when the account cannot be
   * reached: the tracks panel is context, and a project that cannot be
   * examined offline should still open.
   */
  async list(repositoryId: string): Promise<Track[]> {
    try {
      const body = await this.call<{ tracks?: Track[] }>(
        `/v1/repositories/${repositoryId}/tracks`,
      );
      return body.tracks ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Start a new line, from wherever the project currently is.
   *
   * The service decides the starting point and refuses a name it cannot
   * accept, so this passes the name through rather than pre-judging it —
   * a rule enforced in two places is a rule that will disagree with itself.
   */
  async create(
    repositoryId: string,
    name: string,
    /*
      Where the line starts, when the caller knows better than "wherever the
      project is now". Somebody clicking New line means from here; a git branch
      means from the version matching the commit it forked at, which is
      usually not the head. Omitted keeps the original behaviour exactly.
    */
    fromVersionId?: string,
  ): Promise<Track> {
    const body = await this.call<{ track: Track }>(
      `/v1/repositories/${repositoryId}/tracks`,
      {
        method: "POST",
        body: JSON.stringify(fromVersionId ? { name, fromVersionId } : { name }),
      },
    );
    return body.track;
  }

  /** Merges that have not been applied or abandoned. */
  async merges(repositoryId: string): Promise<MergeTrack[]> {
    try {
      const body = await this.call<{ mergeTracks?: MergeTrack[] }>(
        `/v1/repositories/${repositoryId}/merge-tracks`,
      );
      return (body.mergeTracks ?? []).filter(
        (one) => one.state === "open" || one.state === "applying",
      );
    } catch {
      return [];
    }
  }

  /**
   * One merge and every path it is waiting on.
   *
   * The merge itself is nested under `mergeTrack`, which this used to spread
   * flat — so `track.reference` was undefined and the window's title fell
   * back to the word "Merge" on every merge there has ever been. The rest of
   * the reply was thrown away with it, including the two version ids that
   * make showing the conflict possible at all.
   */
  async merge(mergeTrackId: string): Promise<MergeDetail> {
    const body = await this.call<{
      mergeTrack: MergeTrack & {
        repositoryId: string;
        candidateVersionId?: string | null;
      };
      conflicts?: MergeConflict[];
      checks?: MergeCheck[];
      currentTargetVersionId?: string | null;
      provisional?: {
        ready?: boolean;
        unresolvedPaths?: string[];
        blockedByChecks?: string[];
      };
      proposal?: { from: string; into: string };
      changeRequest?: (Omit<MergeRequest, "requested"> & {
        requested?: MergeRequest["requested"];
      }) | null;
    }>(`/v1/merge-tracks/${mergeTrackId}`);
    return {
      track: body.mergeTrack,
      conflicts: body.conflicts ?? [],
      repositoryId: body.mergeTrack.repositoryId,
      candidateVersionId: body.mergeTrack.candidateVersionId ?? null,
      currentTargetVersionId: body.currentTargetVersionId ?? null,
      checks: body.checks ?? [],
      ready: body.provisional?.ready ?? false,
      unresolvedPaths: body.provisional?.unresolvedPaths ?? [],
      blockedByChecks: body.provisional?.blockedByChecks ?? [],
      proposal: body.proposal ?? null,
      request: body.changeRequest
        ? { ...body.changeRequest, requested: body.changeRequest.requested ?? [] }
        : null,
    };
  }

  /**
   * Offer a line to another, usually main.
   *
   * The service reads both lines, combines what it can, and answers with the
   * merge it opened — which the window then shows like any other.
   */
  async propose(
    repositoryId: string,
    input: { from: string; into: string; title: string; body?: string },
  ): Promise<{ mergeTrackId: string; reference: string; unresolved: number }> {
    const body = await this.call<{
      mergeTrack: { id: string; reference: string };
      conflicts: { unresolved: number };
    }>(`/v1/repositories/${repositoryId}/proposals`, {
      method: "POST",
      body: JSON.stringify(input.body ? input : { from: input.from, into: input.into, title: input.title }),
    });
    return {
      mergeTrackId: body.mergeTrack.id,
      reference: body.mergeTrack.reference,
      unresolved: body.conflicts.unresolved,
    };
  }

  /** Say where you stand on a proposal. */
  async review(
    mergeTrackId: string,
    verdict: "approve" | "request_changes",
    note?: string,
  ): Promise<void> {
    await this.call(`/v1/merge-tracks/${mergeTrackId}/review`, {
      method: "PUT",
      body: JSON.stringify(note ? { verdict, body: note } : { verdict }),
    });
  }

  /**
   * One side of a conflict, as text.
   *
   * Both sides of a merge are versions, so this is the ordinary file route.
   * Null means there is genuinely no file on that side, which is half of
   * these conflicts: one person edited what another deleted.
   */
  async fileAt(
    repositoryId: string,
    versionId: string | null,
    path: string,
  ): Promise<{ text: string | null; bytes: number } | null> {
    if (!versionId) return null;
    const token = await this.credentials.token();
    if (!token) throw new Error("Sign in again");
    const response = await fetch(
      `${this.credentials.origin()}/v1/repositories/${repositoryId}` +
        `/versions/${versionId}/file?path=${encodeURIComponent(path)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": "CodeRook/0.1",
          ...clientHeaders(),
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw refusalOrError(
        await response.text().catch(() => ""),
        response.status,
        `Could not read ${path}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    /*
      Decoded strictly, so a file that is not UTF-8 reports itself as binary
      rather than arriving as a screenful of replacement characters somebody
      might then save over the real thing.
    */
    let text: string | null = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\u0000")) text = null;
    } catch {
      text = null;
    }
    return { text, bytes: bytes.byteLength };
  }

  /**
   * Send a file somebody wrote, and answer with the object it became.
   *
   * The other half of an edited resolution: the service takes an object id,
   * and something has to put the bytes there first.
   */
  async putText(
    repositoryId: string,
    path: string,
    text: string,
  ): Promise<string> {
    const token = await this.credentials.token();
    if (!token) throw new Error("Sign in again");
    const bytes = new TextEncoder().encode(text);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const response = await fetch(
      `${this.credentials.origin()}/v1/repositories/${repositoryId}` +
        `/objects/${digest}?kind=chunk&role=chunk&logicalSize=${bytes.byteLength}` +
        `&mediaType=${encodeURIComponent(mediaTypeForPath(path))}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
          "user-agent": "CodeRook/0.1",
          ...clientHeaders(),
        },
        body: bytes,
      },
    );
    const body = await response.text();
    if (!response.ok) throw refusalOrError(body, response.status, "Could not send the file");
    return (JSON.parse(body) as { objectId: string }).objectId;
  }

  /** Settle one path. An edit also names the object it produced. */
  async resolve(
    mergeTrackId: string,
    conflictId: string,
    resolution: Resolution,
    objectId?: string,
  ): Promise<void> {
    await this.call(`/v1/merge-tracks/${mergeTrackId}/conflicts/${conflictId}`, {
      method: "PUT",
      body: JSON.stringify(objectId ? { resolution, objectId } : { resolution }),
    });
  }

  /**
   * Publish the merge, once every path has been settled.
   *
   * The service refuses while anything is unresolved, which is the check that
   * matters — this is only the request.
   */
  async apply(mergeTrackId: string): Promise<{ versionId?: string }> {
    return this.call(`/v1/merge-tracks/${mergeTrackId}/apply`, {
      method: "POST",
      body: "{}",
    });
  }

  /**
   * Abandon it.
   *
   * The candidate's versions are not deleted — they stay on their own track,
   * so nothing that was uploaded is lost by deciding not to merge it.
   */
  async cancel(mergeTrackId: string): Promise<void> {
    await this.call(`/v1/merge-tracks/${mergeTrackId}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }
}
