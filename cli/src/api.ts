/** The small part of the API the command-line tool needs directly. */
import { clientHeaders } from "../../cbx/src/core/identify.js";
import { apiOrigin, loadToken } from "./config.js";

export type AccountProject = {
  id: string;
  slug: string;
  name: string;
  visibility: string;
  /*
    The line a project opens on. Sent by the service and dropped here, which
    is why cloning followed whichever version happened to be newest across
    every line — usually the one somebody else had just pushed to a branch.
  */
  defaultBranch: string;
  versionCount: number;
  fileCount: number;
  storedBytes: number;
  updatedAt: string;
};

export type Account = {
  email: string;
  displayName: string;
  username: string | null;
  plan: string;
};

/**
 * How long one request may go unanswered before it is treated as lost.
 *
 * Nothing here had a deadline, so a request the service never answered
 * waited for ever. A real save of a 38,913-file project stopped dead on one
 * open connection with no bytes moving in either direction and no CPU, and
 * said nothing at all — there is no output to watch, because the client is
 * inside `await fetch`.
 *
 * Three minutes is far longer than any of these calls takes and short enough
 * that a save cannot sit silent all afternoon. A deadline that fires is an
 * ordinary error, so it reaches whatever the caller does about errors rather
 * than ending the run.
 */
const REQUEST_DEADLINE_MS = 180_000;

/**
 * A refusal from the service, with what it said and why.
 *
 * Still an Error carrying the service's own sentence, so every caller that
 * prints `error.message` goes on printing the same words. The status and the
 * code are there for the few commands that answer a particular refusal
 * differently — "not available here yet" is not the same as "not allowed".
 */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

async function call<T>(
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await loadToken();
  if (!token) {
    throw new Error("Not signed in. Run: cbx sign-in");
  }
  const response = await fetch(`${apiOrigin()}${route}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": "CodeRook-CLI/0.1",
      ...clientHeaders(),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("That token was not accepted. Run: cbx sign-in");
    }
    throw new ServiceError(
      body?.error?.message ?? `${route} failed (${response.status})`,
      response.status,
      typeof body?.error?.code === "string" ? body.error.code : null,
    );
  }
  return body as T;
}

/**
 * Send raw bytes, rather than JSON.
 *
 * `call` is built for a JSON request and a JSON reply; an object upload is a
 * body of bytes with the digest in the path, so it needs its own door rather
 * than a flag threaded through that one.
 */
async function send(
  route: string,
  method: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<Record<string, unknown>> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in. Run: cbx sign-in");
  const response = await fetch(`${apiOrigin()}${route}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": "CodeRook-CLI/0.1",
      ...clientHeaders(),
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
    },
    body: bytes,
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ??
        `${route} failed (${response.status})`,
    );
  }
  return body as Record<string, unknown>;
}

/** One object, small enough for a single request. Returns its id. */
export async function putObject(
  repositoryId: string,
  sha256: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<string> {
  const body = await send(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/objects/${sha256}` +
      `?kind=chunk&role=chunk&mediaType=${encodeURIComponent(mediaType)}`,
    "PUT",
    bytes,
    "application/octet-stream",
  );
  return String(body.objectId ?? "");
}

/** Start a multipart upload, for anything the direct route will not take. */
export async function beginUpload(
  repositoryId: string,
  definition: {
    sha256: string;
    size: number;
    mediaType: string;
    kind: "chunk";
    repositoryRole: "chunk";
  },
): Promise<{ uploadSessionId: string; maximumPartBytes: number }> {
  const body = await call<{
    uploadSessionId?: string;
    id?: string;
    maximumPartBytes?: number;
  }>(`/v1/repositories/${encodeURIComponent(repositoryId)}/uploads`, {
    method: "POST",
    body: definition,
  });
  const id = body.uploadSessionId ?? body.id;
  if (!id) throw new Error("The service did not return an upload session");
  return {
    uploadSessionId: String(id),
    maximumPartBytes: Number(body.maximumPartBytes ?? 95 * 1024 * 1024),
  };
}

/** One numbered part of a multipart upload. */
export async function uploadPart(
  uploadSessionId: string,
  partNumber: number,
  bytes: Uint8Array,
): Promise<void> {
  await send(
    `/v1/uploads/${encodeURIComponent(uploadSessionId)}/parts/${partNumber}`,
    "PUT",
    bytes,
    "application/octet-stream",
  );
}

/** Close a multipart upload and take the object it became. */
export async function completeUpload(uploadSessionId: string): Promise<string> {
  const body = await call<{ objectId?: string }>(
    `/v1/uploads/${encodeURIComponent(uploadSessionId)}/complete`,
    { method: "POST" },
  );
  if (!body.objectId) throw new Error("The upload did not produce an object");
  return String(body.objectId);
}

/** Make an object already on the project a download on one of its versions. */
export async function attachToVersion(
  repositoryId: string,
  versionId: string,
  name: string,
  objectId: string,
): Promise<void> {
  await call(
    `/v1/repositories/${encodeURIComponent(repositoryId)}` +
      `/versions/${encodeURIComponent(versionId)}/attachments`,
    { method: "POST", body: { name, objectId } },
  );
}

export async function whoami(): Promise<Account> {
  const body = await call<{ user?: Account }>("/v1/auth/session");
  if (!body.user) throw new Error("That token does not belong to an account");
  return body.user;
}

export async function projects(): Promise<AccountProject[]> {
  const body = await call<{ repositories?: Array<Record<string, unknown>> }>(
    "/v1/repositories",
  );
  return (body.repositories ?? []).map((row) => ({
    id: String(row.id ?? ""),
    slug: String(row.slug ?? ""),
    name: String(row.displayName || row.slug || "Untitled"),
    visibility: String(row.visibility ?? "private"),
    defaultBranch: String(row.defaultBranch || "main"),
    versionCount: Number(row.versionCount ?? 0),
    fileCount: Number(row.fileCount ?? 0),
    storedBytes: Number(row.storedSize ?? 0),
    updatedAt: String(row.updatedAt ?? row.createdAt ?? ""),
  }));
}

/**
 * One project by its id, including somebody else's public or unlisted one.
 *
 * The account's own list holds only projects it is in, so a folder cloned
 * from somebody else's public project had no way back to it: every command
 * after the clone said the project was "no longer on your account". The
 * service answers this route for anybody signed in when the project is open,
 * and says whether the caller is one of its people.
 */
export async function projectById(
  repositoryId: string,
): Promise<(AccountProject & { member: boolean }) | null> {
  try {
    const row = await call<Record<string, unknown>>(
      `/v1/repositories/${encodeURIComponent(repositoryId)}`,
    );
    if (!row.id) return null;
    return {
      id: String(row.id),
      slug: String(row.slug ?? ""),
      name: String(row.displayName || row.slug || "Untitled"),
      visibility: String(row.visibility ?? "public"),
      defaultBranch: String(row.defaultBranch || "main"),
      versionCount: Number(row.versionCount ?? 0),
      fileCount: Number(row.fileCount ?? 0),
      storedBytes: Number(row.storedSize ?? 0),
      updatedAt: String(row.updatedAt ?? row.createdAt ?? ""),
      member: row.member !== false,
    };
  } catch {
    return null;
  }
}

/**
 * One public project, by the two names that identify it.
 *
 * Reachable without an account, which is what public means. Only the lookup
 * goes this way: once the project has been named, everything else is fetched
 * through the ordinary repository routes, which already serve a public
 * project to anybody who asks.
 */
export async function findPublicProject(
  owner: string,
  slug: string,
): Promise<AccountProject | null> {
  try {
    const response = await fetch(
      `${apiOrigin()}/v1/public/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
      {
        headers: { accept: "application/json", ...clientHeaders() },
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      },
    );
    if (!response.ok) return null;
    const row = (await response.json()) as Record<string, unknown>;
    if (!row.id) return null;
    return {
      id: String(row.id),
      slug: String(row.slug ?? slug),
      name: String(row.displayName || row.slug || slug),
      visibility: String(row.visibility ?? "public"),
      defaultBranch: String(row.defaultBranch || "main"),
      versionCount: Number(row.versionCount ?? 0),
      fileCount: Number(row.fileCount ?? 0),
      storedBytes: Number(row.storedSize ?? 0),
      updatedAt: String(row.updatedAt ?? row.createdAt ?? ""),
    };
  } catch {
    /* Offline, or no such project. Either way there is nothing to return. */
    return null;
  }
}

/**
 * Find a project by slug or display name, so either reads naturally.
 *
 * Your own account first, then — for `owner/slug`, or a name that is not
 * yours — the public listing.
 *
 * Without that second step the only projects reachable by name were your
 * own, which made `cbx clone somebody/their-project` answer "No project named
 * … on this account" and `git clone coderook://somebody/their-project` hand
 * back an empty repository. Both are the instruction printed on every public
 * project page, aimed at exactly the people who do not own the thing.
 */
export async function findProject(
  reference: string,
): Promise<AccountProject | null> {
  const trimmed = reference.trim();
  const slash = trimmed.lastIndexOf("/");
  const owner = slash > 0 ? trimmed.slice(0, slash) : "";
  const bare = (slash > 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();

  /*
    An owner was named, so it is somebody's project rather than a name to
    guess at. Yours is still checked first: naming yourself is allowed, and
    the authenticated listing knows about private projects the public one
    cannot see.
  */
  const all = await projects().catch(() => [] as AccountProject[]);
  const ownersMatch = (project: AccountProject) =>
    project.slug.toLowerCase() === bare || project.name.toLowerCase() === bare;

  if (!owner) {
    const mine = all.find(ownersMatch);
    if (mine) return mine;
    return null;
  }

  const me = await whoami().catch(() => null);
  if (me && (me.username ?? "").toLowerCase() === owner.toLowerCase()) {
    const mine = all.find(ownersMatch);
    if (mine) return mine;
  }
  return findPublicProject(owner, bare);
}

/** Whether the service is reachable, and what encodings it accepts. */
export async function health(): Promise<{
  status: string;
  schemaVersion: string;
  contentEncodings?: string[];
}> {
  const response = await fetch(`${apiOrigin()}/health?t=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
    /* A health check that hangs is the one call where waiting is absurd. */
    signal: AbortSignal.timeout(15_000),
  });
  return (await response.json()) as {
    status: string;
    schemaVersion: string;
    contentEncodings?: string[];
  };
}

/**
 * Merges waiting on a decision.
 *
 * An upload that overlapped somebody else's work is not lost and not
 * applied: it sits on a Merge Track until a person says which side wins.
 * These are what let that happen without leaving the terminal.
 */
export type MergeTrackSummary = {
  id: string;
  reference: string;
  state: string;
  createdAt: string;
  conflicts?: { total: number; unresolved: number };
  targetTrack?: string;
  /** Present when this is a line proposed into another, not a collision. */
  proposal?: { from: string | null; into: string | null; title: string | null; state: string | null };
};

export type MergeConflictDetail = {
  id: string;
  kind: string;
  path: string;
  resolution: string | null;
  resolvedAt: string | null;
};

export type MergeTrackDetail = {
  mergeTrack: MergeTrackSummary;
  conflicts: MergeConflictDetail[];
  provisional: {
    fileCount: number;
    unresolvedPaths: string[];
    ready: boolean;
    blockedByChecks?: string[];
  };
  targetTrack?: string;
  proposal?: { from: string; into: string };
  changeRequest?: {
    title: string;
    body: string | null;
    state: string;
    reviews: Array<{
      reviewer: string;
      reviewerName?: string | null;
      verdict: string;
      body: string | null;
    }>;
    approvals: { required: number; approvals: number; satisfied: boolean } | null;
    requested?: Array<{ username: string | null; displayName: string; reviewed: boolean }>;
  } | null;
};

/** Ask people, by username, to review a merge. */
export async function requestReviews(
  mergeTrackId: string,
  usernames: string[],
): Promise<Array<{ username: string | null; displayName: string }>> {
  const body = await call<{ asked: Array<{ username: string | null; displayName: string }> }>(
    `/v1/merge-tracks/${mergeTrackId}/review-requests`,
    { method: "POST", body: { reviewers: usernames } },
  );
  return body.asked;
}

/** Offer a line of work to another, usually main. */
export async function openProposal(
  repositoryId: string,
  input: { from: string; into: string; title: string; body?: string },
): Promise<{
  mergeTrack: MergeTrackSummary;
  conflicts: { unresolved: number; settled: number };
}> {
  return call(`/v1/repositories/${repositoryId}/proposals`, {
    method: "POST",
    body: input,
  });
}

export async function proposals(
  repositoryId: string,
  all = false,
): Promise<MergeTrackSummary[]> {
  const body = await call<{ proposals: MergeTrackSummary[] }>(
    `/v1/repositories/${repositoryId}/proposals${all ? "?state=all" : ""}`,
  );
  return body.proposals;
}

export async function mergeTracks(
  repositoryId: string,
): Promise<MergeTrackSummary[]> {
  const body = await call<{ mergeTracks: MergeTrackSummary[] }>(
    `/v1/repositories/${repositoryId}/merge-tracks`,
  );
  return body.mergeTracks;
}

export async function mergeTrack(id: string): Promise<MergeTrackDetail> {
  return call<MergeTrackDetail>(`/v1/merge-tracks/${id}`);
}

export async function resolveMergeConflict(
  mergeTrackId: string,
  conflictId: string,
  resolution: "take_target" | "take_candidate" | "delete" | "keep_both",
): Promise<void> {
  await call(`/v1/merge-tracks/${mergeTrackId}/conflicts/${conflictId}`, {
    method: "PUT",
    body: { resolution },
  });
}

export async function applyMerge(
  mergeTrackId: string,
): Promise<{ version: { sequence: number }; closedIssues?: number[] }> {
  return call<{ version: { sequence: number }; closedIssues?: number[] }>(
    `/v1/merge-tracks/${mergeTrackId}/apply`,
    { method: "POST" },
  );
}

export async function cancelMerge(mergeTrackId: string): Promise<void> {
  await call(`/v1/merge-tracks/${mergeTrackId}/cancel`, { method: "POST" });
}

/** The four answers a project gives about machines. */
export type AiAccess = {
  aiRead: boolean;
  aiDownload: boolean;
  aiContribute: boolean;
  aiRequest: boolean;
};

/**
 * Read one project's machine-access answers.
 *
 * Taken from the project record rather than a dedicated endpoint, because
 * that is where they live — four columns on the repository, not a separate
 * resource. Defaults to permissive, matching the service: a project that has
 * never been touched allows everything.
 */
export async function aiAccess(repositoryId: string): Promise<AiAccess> {
  const body = await call<Record<string, unknown>>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}`,
  );
  const project = (body.repository ?? body) as Record<string, unknown>;
  /*
    Read from the nested object the service actually sends, not from flat
    fields beside it. Writing uses `aiRead`; reading returns `ai.read`, and
    binding to the write shape made every setting report as allowed — a
    missing field is not false, so a project with reading switched off said
    it was on. The asymmetry is the API's; the mistake was assuming it away
    rather than looking.
  */
  const ai = (project.ai ?? {}) as Record<string, unknown>;
  const allowed = (key: string) => ai[key] !== false;
  return {
    aiRead: allowed("read"),
    aiDownload: allowed("download"),
    aiContribute: allowed("contribute"),
    aiRequest: allowed("request"),
  };
}

/**
 * Change one answer.
 *
 * One at a time, matching the site: each is a separate decision, and sending
 * all four would make turning off downloads look like it needed a view about
 * indexing as well.
 */
export async function setAiAccess(
  repositoryId: string,
  change: Partial<AiAccess>,
): Promise<void> {
  await call(`/v1/repositories/${encodeURIComponent(repositoryId)}`, {
    method: "PATCH",
    body: change,
  });
}

/**
 * Change what a project says about itself.
 *
 * The same PATCH the AI switches use, which is where these live: a handful of
 * columns on the repository rather than a resource of their own.
 */
export async function updateProject(
  repositoryId: string,
  change: {
    displayName?: string;
    description?: string;
    visibility?: "private" | "unlisted" | "public";
  },
): Promise<void> {
  await call(`/v1/repositories/${encodeURIComponent(repositoryId)}`, {
    method: "PATCH",
    body: change,
  });
}

/**
 * A project served as a website, as the service describes it.
 *
 * `address` is null until the service has a Pages domain, which is a fact
 * about the service rather than the project — a project can be switched on
 * and correctly configured and still have nowhere to be reached yet.
 */
export type PagesSettings = {
  enabled: boolean;
  /** "" is the top of the project; otherwise e.g. "dist" or "Build/WebGL". */
  folder: string;
  /** Pinned version, or null for the newest published one. */
  versionId: string | null;
  spa: boolean;
  isolation: boolean;
  address: string | null;
  domainReady: boolean;
  live: { id: string; sequence: number; name: string | null } | null;
  entry: { path: string; found: boolean } | null;
  blocked: string | null;
};

export type PagesKind = "unity" | "godot" | "vite" | "next" | "react" | "static";

export type PagesDetection = {
  version: { id: string; sequence: number; name: string | null } | null;
  suggestion: {
    folder: string;
    kind: PagesKind;
    spa: boolean;
    isolation: boolean;
    why: string;
  } | null;
  candidates: Array<{ folder: string; kind: PagesKind; why: string }>;
  problem: string | null;
};

export type PagesChange = {
  enabled?: boolean;
  folder?: string;
  versionId?: string | null;
  spa?: boolean;
  isolation?: boolean;
};

function pagesSettings(row: Record<string, unknown>): PagesSettings {
  const live = row.live as Record<string, unknown> | null | undefined;
  const entry = row.entry as Record<string, unknown> | null | undefined;
  return {
    enabled: row.enabled === true,
    folder: String(row.folder ?? ""),
    versionId: row.versionId == null ? null : String(row.versionId),
    spa: row.spa === true,
    isolation: row.isolation === true,
    address: row.address == null ? null : String(row.address),
    domainReady: row.domainReady === true,
    live: live
      ? {
          id: String(live.id ?? ""),
          sequence: Number(live.sequence ?? 0),
          name: live.name == null ? null : String(live.name),
        }
      : null,
    entry: entry
      ? { path: String(entry.path ?? ""), found: entry.found === true }
      : null,
    blocked: row.blocked == null ? null : String(row.blocked),
  };
}

const pagesRoute = (repositoryId: string) =>
  `/v1/repositories/${encodeURIComponent(repositoryId)}/pages`;

/** What a project's site is set to, and what it is serving. */
export async function pages(repositoryId: string): Promise<PagesSettings> {
  return pagesSettings(await call<Record<string, unknown>>(pagesRoute(repositoryId)));
}

/** Change a project's site. Only what is given is sent. */
export async function setPages(
  repositoryId: string,
  change: PagesChange,
): Promise<PagesSettings> {
  return pagesSettings(
    await call<Record<string, unknown>>(pagesRoute(repositoryId), {
      method: "PUT",
      body: change,
    }),
  );
}

/** What the newest published version looks like it could serve. */
export async function detectPages(repositoryId: string): Promise<PagesDetection> {
  const body = await call<Record<string, unknown>>(
    `${pagesRoute(repositoryId)}/detect`,
  );
  const version = body.version as Record<string, unknown> | null | undefined;
  const suggestion = body.suggestion as Record<string, unknown> | null | undefined;
  return {
    version: version
      ? {
          id: String(version.id ?? ""),
          sequence: Number(version.sequence ?? 0),
          name: version.name == null ? null : String(version.name),
        }
      : null,
    suggestion: suggestion
      ? {
          folder: String(suggestion.folder ?? ""),
          kind: String(suggestion.kind ?? "static") as PagesKind,
          spa: suggestion.spa === true,
          isolation: suggestion.isolation === true,
          why: String(suggestion.why ?? ""),
        }
      : null,
    candidates: Array.isArray(body.candidates)
      ? (body.candidates as Array<Record<string, unknown>>).map((one) => ({
          folder: String(one.folder ?? ""),
          kind: String(one.kind ?? "static") as PagesKind,
          why: String(one.why ?? ""),
        }))
      : [],
    problem: body.problem == null ? null : String(body.problem),
  };
}

/**
 * Detect and apply in one request, so what is switched on is what the
 * service found rather than what this client last saw.
 */
export async function autoPages(
  repositoryId: string,
): Promise<PagesSettings & { applied: PagesDetection["suggestion"] }> {
  const body = await call<Record<string, unknown>>(
    `${pagesRoute(repositoryId)}/auto`,
    { method: "POST" },
  );
  const applied = body.applied as Record<string, unknown> | null | undefined;
  return {
    ...pagesSettings(body),
    applied: applied
      ? {
          folder: String(applied.folder ?? ""),
          kind: String(applied.kind ?? "static") as PagesKind,
          spa: applied.spa === true,
          isolation: applied.isolation === true,
          why: String(applied.why ?? ""),
        }
      : null,
  };
}

/** Every saved version of a project, newest first. */
/** One file's difference between two versions, as the service sees it. */
export type TreeChange = {
  path: string;
  kind: "added" | "removed" | "changed";
};

/**
 * What changed between two saved versions.
 *
 * The service answers this from the stored trees, so an untouched folder deep
 * in the project costs nothing: identical subtree ids short-circuit before
 * either side is listed. That is why this asks the service rather than
 * fetching both file lists and comparing them here — on a project of twenty
 * thousand files the difference is one request against two very large ones.
 */
export async function compareVersions(
  repositoryId: string,
  from: string,
  to: string,
): Promise<TreeChange[]> {
  const body = await call<{ changes?: TreeChange[] }>(
    `/v1/repositories/${repositoryId}/compare` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return body.changes ?? [];
}

/**
 * One file's contents at one version, as text.
 *
 * Returns null for anything that is not text — a diff of a PNG is noise, and
 * deciding that here keeps every caller from having to guess. The byte cap is
 * the same reasoning: past it a file is data, and a line-by-line comparison of
 * data is neither readable nor quick.
 */
export async function fileTextAt(
  repositoryId: string,
  versionId: string,
  filePath: string,
  mostBytes = 2 * 1024 * 1024,
): Promise<string | null> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in. Run: cbx sign-in");
  const route =
    `${apiOrigin()}/v1/repositories/${repositoryId}` +
    `/versions/${versionId}/file?path=${encodeURIComponent(filePath)}`;
  const response = await fetch(route, {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "CodeRook-CLI/0.1",
      ...clientHeaders(),
      range: `bytes=0-${mostBytes - 1}`,
    },
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  /* A NUL byte is the cheapest reliable sign that this is not text. */
  if (bytes.includes(0)) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function versions(
  repositoryId: string,
): Promise<
  Array<{
    id: string;
    sequence: number;
    message: string;
    fileCount: number;
    storedSize: number;
    createdAt: string;
    /*
      The Versions this one continues, oldest line first, then anything it
      brought in. Two entries means a merge — the only record afterwards that
      two lines ever came together, and the reason a git history rebuilt from
      these can keep its shape instead of being flattened into one line.
    */
    parentVersionIds: string[];
    authorName: string;
    /* What the project has made of it, for clients that show more than a list. */
    name: string | null;
    /*
      What somebody wrote about this version — the release info the website
      shows and `cbx notes` reads. Absent from this shape until the terminal
      needed to read it back rather than only write it.
    */
    notes: string | null;
    visibility: "private" | "public";
    state: string;
    pinned: boolean;
    labels: VersionLabel[];
    removedAt: string | null;
    /** Whether the project is standing on this one right now. */
    head: boolean;
  }>
> {
  const body = await call<{ versions?: Array<Record<string, unknown>> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/versions`,
  );
  return (body.versions ?? []).map((row) => ({
    id: String(row.id ?? ""),
    sequence: Number(row.sequence ?? 0),
    message: String(row.message ?? ""),
    fileCount: Number(row.fileCount ?? 0),
    storedSize: Number(row.storedSize ?? row.sourceSize ?? 0),
    createdAt: String(row.createdAt ?? ""),
    parentVersionIds: Array.isArray(row.parentVersionIds)
      ? (row.parentVersionIds as unknown[]).map(String)
      : [],
    authorName: String(
      (row.author as { displayName?: string } | undefined)?.displayName ?? "",
    ),
    name: row.name == null ? null : String(row.name),
    notes: row.notes == null ? null : String(row.notes),
    /*
      Falls back to the older field, so this keeps working against a service
      that has not been updated yet rather than reporting everything private.
    */
    visibility:
      (row.visibility as "private" | "public" | undefined) ??
      (row.public === false ? "private" : "public"),
    state: String(row.state ?? "verified"),
    pinned: row.pinned === true,
    labels: Array.isArray(row.labels)
      ? (row.labels as Array<Record<string, unknown>>).map((one) => ({
          id: String(one.id ?? ""),
          name: String(one.name ?? ""),
          colour: String(one.colour ?? "#888888"),
          description: one.description == null ? null : String(one.description),
        }))
      : [],
    removedAt: row.removedAt == null ? null : String(row.removedAt),
    head: row.head === true,
  }));
}

/**
 * Give a version a name, which is all a release is.
 *
 * Used to carry a pushed git tag across. `markRelease` on the service side is
 * an update on the version row rather than a new object, so this is idempotent
 * — pushing the same tag twice renames the same version to the same thing
 * rather than making a second release.
 */
export async function markRelease(
  repositoryId: string,
  versionId: string,
  name: string,
  notes?: string | null,
): Promise<{ name: string; versionId: string }> {
  const body = await call<{ release?: { name?: string; versionId?: string } }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}` +
      `/versions/${encodeURIComponent(versionId)}/release`,
    // `call` serialises the body itself; handing it a string would send a
    // JSON-encoded string where the service expects an object.
    { method: "PUT", body: { name, ...(notes ? { notes } : {}) } },
  );
  return {
    name: String(body.release?.name ?? name),
    versionId: String(body.release?.versionId ?? versionId),
  };
}

export type Issue = {
  number: number;
  title: string;
  state: string;
  labels: string[];
  commentCount: number;
  createdAt: string;
};

export async function issues(repositoryId: string): Promise<{
  issues: Issue[];
  openCount: number;
  closedCount: number;
}> {
  const body = await call<{
    issues?: Array<Record<string, unknown>>;
    openCount?: number;
    closedCount?: number;
  }>(`/v1/repositories/${encodeURIComponent(repositoryId)}/issues`);
  return {
    issues: (body.issues ?? []).map((row) => ({
      number: Number(row.number ?? 0),
      title: String(row.title ?? ""),
      state: String(row.state ?? "open"),
      labels: Array.isArray(row.labels) ? (row.labels as string[]) : [],
      commentCount: Number(row.commentCount ?? 0),
      createdAt: String(row.createdAt ?? ""),
    })),
    openCount: Number(body.openCount ?? 0),
    closedCount: Number(body.closedCount ?? 0),
  };
}

export async function createIssue(
  repositoryId: string,
  input: {
    title: string;
    body?: string;
    /** Names to wear. The service makes any that do not exist yet. */
    labels?: string[];
    /** Which save it is about, when it is about one. */
    versionId?: string;
  },
): Promise<{ number: number }> {
  /*
    The number comes back at the top level, not nested under an `issue` key.
    Reading the wrong shape reported every new issue as #0 — harmless in
    itself, and exactly the kind of small wrongness that makes somebody stop
    trusting the rest of the output.
  */
  const created = await call<{ id?: string; number?: number }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/issues`,
    {
      method: "POST",
      body: {
        title: input.title,
        body: input.body ?? "",
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.versionId ? { versionId: input.versionId } : {}),
      },
    },
  );
  return { number: Number(created.number ?? 0) };
}

export async function releases(repositoryId: string): Promise<
  Array<{
    /*
      Which version was named. The service has always sent this and the client
      dropped it, which left a release identifiable only by its sequence
      number — fine for printing a list, useless for tying one back to the
      commit it belongs to.
    */
    versionId: string;
    sequence: number;
    name: string;
    notes: string;
    releasedAt: string;
    releasedBy: string;
    assets: unknown[];
  }>
> {
  const body = await call<{ releases?: Array<Record<string, unknown>> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/releases`,
  );
  return (body.releases ?? []).map((row) => ({
    versionId: String(row.versionId ?? ""),
    sequence: Number(row.sequence ?? 0),
    name: String(row.name ?? ""),
    notes: String(row.notes ?? ""),
    releasedAt: String(row.releasedAt ?? ""),
    releasedBy: String(row.releasedBy ?? ""),
    assets: Array.isArray(row.assets) ? row.assets : [],
  }));
}

export async function collaborators(repositoryId: string): Promise<{
  collaborators: Array<{ displayName: string; email: string; role: string }>;
  invites: Array<{ email: string; role: string; expiresAt: string }>;
}> {
  const body = await call<{
    collaborators?: Array<Record<string, unknown>>;
    invites?: Array<Record<string, unknown>>;
  }>(`/v1/repositories/${encodeURIComponent(repositoryId)}/collaborators`);
  return {
    collaborators: (body.collaborators ?? []).map((row) => ({
      displayName: String(row.displayName ?? ""),
      email: String(row.email ?? ""),
      role: String(row.role ?? "member"),
    })),
    invites: (body.invites ?? []).map((row) => ({
      email: String(row.email ?? ""),
      role: String(row.role ?? "member"),
      expiresAt: String(row.expiresAt ?? row.expires_at ?? ""),
    })),
  };
}

export async function invite(
  repositoryId: string,
  input: { email: string; role: string },
): Promise<void> {
  await call(`/v1/repositories/${encodeURIComponent(repositoryId)}/invites`, {
    method: "POST",
    body: input,
  });
}

export type WatchSettings = {
  level: string;
  inApp: boolean;
  desktop: boolean;
  emailDigest: boolean;
};

export async function watch(repositoryId: string): Promise<WatchSettings> {
  const body = await call<Record<string, unknown>>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/watch`,
  );
  return {
    level: String(body.level ?? "versions"),
    inApp: body.inApp !== false,
    desktop: body.desktop === true,
    emailDigest: body.emailDigest === true,
  };
}

export async function setWatch(
  repositoryId: string,
  change: Partial<WatchSettings>,
): Promise<void> {
  await call(`/v1/repositories/${encodeURIComponent(repositoryId)}/watch`, {
    method: "PUT",
    body: change,
  });
}

export type Workflow = {
  id: string;
  name: string;
  trigger: string;
  command: string;
  runsOn: string;
  /** What it keeps when it finishes, relative to the checkout. */
  artifactPaths: string[];
  /** Whether a passing run's output becomes downloads on its version. */
  attachArtifacts: boolean;
  runs: number;
  passing: number;
  archivedAt: string | null;
};

export async function workflows(repositoryId: string): Promise<Workflow[]> {
  const body = await call<{ workflows?: Array<Record<string, unknown>> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/workflows`,
  );
  return (body.workflows ?? []).map((row) => ({
    /*
      The id was dropped here for as long as this only ever printed a list.
      Anything that acts on one workflow needs it, and a list that has thrown
      away the identity of its rows can only be re-fetched.
    */
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    trigger: String(row.trigger ?? ""),
    command: String(row.command ?? ""),
    runsOn: String(row.runsOn ?? "hosted"),
    artifactPaths: Array.isArray(row.artifactPaths)
      ? row.artifactPaths.map((one) => String(one))
      : [],
    attachArtifacts: row.attachArtifacts === true,
    runs: Number(row.runs ?? 0),
    passing: Number(row.passing ?? 0),
    archivedAt: row.archivedAt ? String(row.archivedAt) : null,
  }));
}

/** Change a workflow. Only what is named is touched. */
export async function changeWorkflow(
  repositoryId: string,
  workflowId: string,
  change: Record<string, unknown>,
): Promise<void> {
  await call(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/workflows/${encodeURIComponent(workflowId)}`,
    { method: "PATCH", body: change },
  );
}

export type Run = {
  id: string;
  number: number;
  workflow: string;
  version: number | null;
  status: string;
  summary: string;
  /** Which machine took it — the first question about a run that is stuck. */
  claimedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

/**
 * What has run on a project.
 *
 * The same route the workflow list comes from; the service returns both and
 * the CLI was throwing half of it away. Filters are passed through rather
 * than applied here, because a project with a thousand runs should not send
 * a thousand rows to show ten.
 */
export async function runs(
  repositoryId: string,
  filter: { status?: string; workflow?: string } = {},
): Promise<Run[]> {
  const query = new URLSearchParams();
  if (filter.status) query.set("status", filter.status);
  if (filter.workflow) query.set("workflow", filter.workflow);
  const suffix = query.size ? `?${query.toString()}` : "";
  const body = await call<{ runs?: Array<Record<string, unknown>> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/workflows${suffix}`,
  );
  return (body.runs ?? []).map((row) => {
    const workflow = (row.workflow ?? {}) as Record<string, unknown>;
    const version = (row.version ?? null) as Record<string, unknown> | null;
    return {
      id: String(row.id ?? ""),
      number: Number(row.number ?? 0),
      workflow: String(workflow.name ?? ""),
      version: version ? Number(version.sequence ?? 0) : null,
      status: String(row.status ?? ""),
      summary: String(row.summary ?? ""),
      claimedBy: row.claimedBy ? String(row.claimedBy) : null,
      startedAt: row.startedAt ? String(row.startedAt) : null,
      finishedAt: row.finishedAt ? String(row.finishedAt) : null,
      durationMs: row.durationMs === null || row.durationMs === undefined
        ? null
        : Number(row.durationMs),
    };
  });
}

/** Everything a run printed, in the order it printed it. */
export async function runLogs(
  repositoryId: string,
  runId: string,
): Promise<Array<{ lineNumber: number; stream: string; line: string }>> {
  const body = await call<{
    lines?: Array<{ lineNumber: number; stream: string; line: string }>;
  }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/runs/` +
      `${encodeURIComponent(runId)}/logs`,
  );
  return body.lines ?? [];
}

/** Personal access tokens on the account. */
export async function tokens(): Promise<
  Array<{ id: string; name: string; lastUsedAt: string; createdAt: string }>
> {
  const body = await call<{ tokens?: Array<Record<string, unknown>> }>(
    "/v1/account/tokens",
  );
  return (body.tokens ?? []).map((row) => ({
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    lastUsedAt: String(row.lastUsedAt ?? ""),
    createdAt: String(row.createdAt ?? ""),
  }));
}

export async function revokeToken(tokenId: string): Promise<void> {
  await call(`/v1/account/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
}

/** Remove a project. The service keeps it for its retention window. */
export async function deleteProject(repositoryId: string): Promise<void> {
  await call(`/v1/repositories/${encodeURIComponent(repositoryId)}`, {
    method: "DELETE",
  });
}

/* ------------------------------------------------ arranging your versions -- */

export type VersionLabel = {
  id: string;
  name: string;
  colour: string;
  description: string | null;
};

export async function projectLabels(
  repositoryId: string,
): Promise<VersionLabel[]> {
  const body = await call<{ labels?: Array<Record<string, unknown>> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/labels`,
  );
  return (body.labels ?? []).map((row) => ({
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    colour: String(row.colour ?? "#888888"),
    description: row.description == null ? null : String(row.description),
  }));
}

export async function createProjectLabel(
  repositoryId: string,
  name: string,
  colour: string,
  description?: string | null,
): Promise<VersionLabel> {
  const body = await call<{ label?: Record<string, unknown> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/labels`,
    { method: "POST", body: { name, colour, ...(description ? { description } : {}) } },
  );
  return {
    id: String(body.label?.id ?? ""),
    name: String(body.label?.name ?? name),
    colour: String(body.label?.colour ?? colour),
    description: body.label?.description == null ? null : String(body.label.description),
  };
}

export async function deleteProjectLabel(
  repositoryId: string,
  labelId: string,
): Promise<void> {
  await call(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/labels/${encodeURIComponent(labelId)}`,
    { method: "DELETE" },
  );
}

/**
 * Everything about a version, changed in one call.
 *
 * Deliberately one request rather than one per field. The service takes a
 * patch, so a command that sets a name and a colour at once is one round trip
 * and, more to the point, one thing that either happened or did not.
 */
export async function changeVersion(
  repositoryId: string,
  versionId: string,
  patch: {
    name?: string | null;
    notes?: string | null;
    visibility?: "private" | "unlisted" | "public";
    pinned?: boolean;
    displayOrder?: number | null;
    labelIds?: string[];
  },
): Promise<void> {
  await call(
    `/v1/repositories/${encodeURIComponent(repositoryId)}` +
      `/versions/${encodeURIComponent(versionId)}`,
    { method: "PATCH", body: patch },
  );
}

/** Accept a held version, or turn it down with a reason. */
export async function reviewVersion(
  repositoryId: string,
  versionId: string,
  decision: "approve" | "decline",
  note?: string | null,
): Promise<{ state: string }> {
  const body = await call<{ state?: string }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}` +
      `/versions/${encodeURIComponent(versionId)}/review`,
    { method: "POST", body: { decision, ...(note ? { note } : {}) } },
  );
  return { state: String(body.state ?? decision) };
}

/** Take a version's content down, leaving the version itself as a record. */
export async function removeVersionContent(
  repositoryId: string,
  versionId: string,
  reason?: string | null,
): Promise<void> {
  const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
  await call(
    `/v1/repositories/${encodeURIComponent(repositoryId)}` +
      `/versions/${encodeURIComponent(versionId)}/content${query}`,
    { method: "DELETE" },
  );
}

export async function versionAttachments(
  repositoryId: string,
  versionId: string,
): Promise<Array<{ id: string; name: string; sizeBytes: number; mediaType: string }>> {
  const body = await call<{ attachments?: Array<Record<string, unknown>> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}` +
      `/versions/${encodeURIComponent(versionId)}/attachments`,
  );
  return (body.attachments ?? []).map((row) => ({
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    sizeBytes: Number(row.sizeBytes ?? 0),
    mediaType: String(row.mediaType ?? "application/octet-stream"),
  }));
}

/** Put the project back on an earlier commit. */
export async function undoTo(
  repositoryId: string,
  to?: string | null,
): Promise<{
  from: { id: string; sequence: number };
  to: { id: string; sequence: number };
  skipped: Array<{ id: string; sequence: number; name: string | null }>;
}> {
  return await call(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/undo`,
    { method: "POST", body: to ? { to } : {} },
  );
}

/* ---------------------------------------------------------------- hooks -- */

export type Webhook = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  lastDeliveredAt: string | null;
  consecutiveFailures: number;
};

/** Where this project tells somebody else that something happened. */
export async function webhooks(repositoryId: string): Promise<Webhook[]> {
  const body = await call<{ webhooks?: Array<Record<string, unknown>> }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/webhooks`,
  );
  return (body.webhooks ?? []).map((row) => ({
    id: String(row.id ?? ""),
    url: String(row.url ?? ""),
    events: Array.isArray(row.events) ? row.events.map((one) => String(one)) : [],
    active: row.active !== false,
    lastDeliveredAt: row.last_delivered_at
      ? String(row.last_delivered_at)
      : null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
  }));
}

/**
 * Add one, and answer with the signing secret.
 *
 * The secret is generated by the service and returned exactly once — it is
 * not readable from any route afterwards — so whatever prints this is the
 * only chance anybody gets to write it down.
 */
export async function addWebhook(
  repositoryId: string,
  url: string,
  events: string[],
): Promise<{ id: string; secret: string }> {
  const created = await call<{ id?: string; secret?: string }>(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/webhooks`,
    { method: "POST", body: events.length ? { url, events } : { url } },
  );
  return { id: String(created.id ?? ""), secret: String(created.secret ?? "") };
}

export async function removeWebhook(
  repositoryId: string,
  webhookId: string,
): Promise<void> {
  await call(
    `/v1/repositories/${encodeURIComponent(repositoryId)}/webhooks/${encodeURIComponent(webhookId)}`,
    { method: "DELETE" },
  );
}

/**
 * What would collide if this folder published right now.
 *
 * Advice, asked before anything is sent. The service has offered this since
 * Merge Tracks shipped and no client asked, so the first anybody heard that
 * their upload was walking into a merge was after it had finished — which on
 * a slow line is the worst possible moment to find out.
 *
 * The answer can be stale by the time the publish arrives; the publish path
 * decides for real. That is why this warns rather than refuses.
 */
export async function collisionCheck(
  repositoryId: string,
  baseVersionId: string | null,
  paths: string[],
): Promise<{ behind: boolean; movedPaths: string[]; collidingPaths: string[] }> {
  const body = await call<{
    behind?: boolean;
    movedPaths?: string[];
    collidingPaths?: string[];
  }>(`/v1/repositories/${encodeURIComponent(repositoryId)}/collision-check`, {
    method: "POST",
    /*
      Capped, because this is advice and a folder can hold a hundred thousand
      paths. The colliding ones are what matter and a long list of them is
      already a merge nobody wants to read on a terminal.
    */
    body: { baseVersionId, paths: paths.slice(0, 5000) },
  });
  return {
    behind: body.behind === true,
    movedPaths: body.movedPaths ?? [],
    collidingPaths: body.collidingPaths ?? [],
  };
}
