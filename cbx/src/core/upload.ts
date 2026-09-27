/**
 * Sending a version to CodeRook.
 *
 * Every file becomes a content-addressed object, then one version record
 * names them all. Objects are addressed by the digest of their contents, so
 * a file that has not changed since the last version costs nothing to send
 * again — the server already has it.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  UploadObjectDefinition,
  UploadPlan,
  UploadProgress,
} from "../shared/types.js";
import type { Credentials } from "./credentials.js";
import { maybeFail } from "./faults.js";
import { clientHeaders } from "./identify.js";
import { collectLayers, gitTracked, readRules, surveyFiles } from "./worktree.js";
import { excludes } from "./rules.js";
import { publishAttemptName } from "./publish_name.js";
import { encodeForUpload, type Encoded } from "./compress.js";
import {
  freshGzipVerdict,
  noteChunkOutcome,
  type GzipVerdict,
} from "../shared/compression_policy.js";
import {
  cutPoints,
  profileForFileSize,
  microchunkProfileForFileSize,
  type ChunkProfile,
} from "../shared/chunking.js";
import {
  acceptedManifestDigests,
  retainedBasePaths,
} from "../shared/publication.js";
import { counted, timed } from "./profile.js";
import { buildSolidPack, type SolidPack } from "./solid.js";
import {
  RETRY_ATTEMPTS,
  RETRY_FIRST_WAIT_MS,
  pauseFor,
  worthRetrying,
} from "./retry.js";
import { PACKABLE_LIMIT, planSections } from "./staging.js";
import { TransferProgress } from "./transfer_progress.js";
import {
  createDeltaPatch,
  decodeDeltaSignatureBatch,
  encodeDeltaBatchEnvelope,
  encodeDeltaEnvelope,
  estimateDeltaSignatureBytes,
  parseDeltaSignature,
  DELTA_BATCH_MAX_FILES,
  DELTA_BATCH_MAX_SOURCE_BYTES,
  DELTA_MAX_FILE_BYTES,
} from "../shared/delta.js";
import {
  RepositoryTelemetry,
  type RepositoryTelemetrySnapshot,
} from "../shared/telemetry.js";

/** One chunk of a file: where it sits, and the digest of what is there. */
type ChunkLayout = Array<{ offset: number; length: number; digest: string }>;

/** Above this the API insists on a multipart session. */
const DIRECT_LIMIT = 95 * 1024 * 1024;
/*
  Above this a file is cut into content-defined chunks instead of being sent
  whole. Below it the round trips cost more than the chunking saves — the
  chunker's own average chunk is eight megabytes, so a smaller file would
  usually come out as one chunk anyway.
*/
const CHUNK_THRESHOLD = 8 * 1024 * 1024;
/*
  How many files are sent at once. Six is the limit browsers settled on per
  host for the same reason: enough to keep the link busy through the latency
  of each request, few enough that a slow service is not buried by a client.
*/
const UPLOAD_LANES = 6;
/*
  What counts as small enough to travel with others, defined once in
  staging.ts and imported here. The planner groups sections by the same line
  the sender batches on, which for a while they did not — see the note beside
  PACKABLE_LIMIT for what that cost.
*/
const BATCH_FILE_LIMIT = PACKABLE_LIMIT;
/** How much one batch may carry, and how many objects it may name. */
const BATCH_BYTES = 24 * 1024 * 1024;
const BATCH_COUNT = 256;
const PART_SIZE = 32 * 1024 * 1024;

/* Retrying lives in retry.ts; the downloader needs the same rule. */

const MEDIA_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".svg": "image/svg+xml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function mediaTypeOf(file: string): string {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Hash without holding the file in memory; some of these are large. */
async function digestOf(full: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * How long one request may go unanswered before it is treated as lost.
 *
 * Three minutes, which is far longer than any request this makes has taken
 * and short enough that a save cannot sit silent all afternoon. What follows
 * a deadline is a retry, not a failure, so the cost of it firing early on a
 * genuinely slow call is one repeated request.
 */
const REQUEST_DEADLINE_MS = 180_000;

export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled");
  }
}

type Declaration = {
  path: string;
  full: string;
  size: number;
  sha256: string;
  mediaType: string;
};

export type UploadResult = {
  repositoryId: string;
  versionId: string;
  sequence: number;
  /** Saved, but waiting for an admin to accept it. */
  held?: boolean;
  /** Everything the version holds. */
  sourceBytes: number;
  storedBytes: number;
  /** What actually went over the wire, which is usually far less. */
  sentBytes: number;
  sentFiles: number;
  reusedFiles: number;
  /** Selected for sending, but the service already had the content. */
  alreadyStoredFiles: number;
  /** Path to digest, so the next scan knows what is already saved. */
  manifest: Record<string, string>;
  /*
    What this machine actually holds now that the save is done: path to the
    digest of the copy sitting in the folder. This is not the version — a
    merge can take somebody else's bytes into the version without them ever
    arriving here — and recording it is what stops the next save from
    mistaking a stale copy for a fresh edit and undoing their work.
  */
  local: Record<string, string>;
  /*
    True when the service recognised this as an attempt it had already
    completed. Worth saying out loud: somebody who saw a connection fail and
    ran the command again deserves to know their earlier attempt had in fact
    worked, rather than believing they saved it twice.
  */
  repeated?: boolean;
  /*
    Set when the upload could not go straight onto the project because
    somebody else had saved first and the two overlap. The work is kept and
    complete; it is waiting on a decision. Callers must not report this as a
    saved version, because what other people see has not changed.
  */
  mergeTrack?: {
    id: string;
    reference: string;
    conflicts: Array<{ kind: string; path: string }>;
  };
  /** Exact client-side protocol accounting for this publication attempt. */
  telemetry?: RepositoryTelemetrySnapshot;
};

export type UploadRequest = {
  /*
    Set when somebody has been shown what the check found and said to go on
    anyway. Absent on a first attempt, which is what makes the refusal
    happen once rather than every time.
  */
  acknowledged?: boolean;
  /*
    Set when somebody has chosen not to have a licence added to a new project.
    Absent means the default applies, which is the point of it — the person
    who never thinks about licensing is exactly who it is for.
  */
  acknowledgedNoLicence?: boolean;
  /*
    Publish files the ignore rules exclude, on purpose.

    Import needs this and ordinary saving must not have it. Git keeps tracking
    a file committed before the rule that excludes it, so a faithful import of
    a real repository routinely carries paths its own `.gitignore` would now
    refuse — refusing them would silently drop files the source repository
    holds. The server records the override in the audit trail either way.
  */
  allowIgnored?: boolean;
  /** Publish a credential on purpose, having been asked and said yes. */
  allowSecrets?: boolean;
  localPath: string;
  /*
    Digests already taken for this folder, keyed by path.

    A version holds every file, so every file has to be declared — but a file
    whose size and modification time are unchanged since it was last hashed
    does not have to be read again to find that out. Without this, a save that
    touches three files re-read all twenty-one thousand: the panel said
    "3 of 3 changes" and then spent minutes on "8,205 of 21,068", which is the
    application disagreeing with itself in front of somebody.

    Absent means hash everything, which is what an import or a folder with no
    history needs.
  */
  knownDigests?: Map<string, { size: number; mtimeMs: number; sha256: string }>;
  /*
    What this save changes, counted by the client over the ticked files.

    Recorded rather than derived: the service holds whole files, not diffs,
    so after the fact there is nothing left to count from. Absent on an
    import or any publish with no working folder behind it.
  */
  linesAdded?: number;
  linesRemoved?: number;
  /** Paths ticked in the changes list; everything else keeps its old copy. */
  include: string[];
  /*
    Paths deliberately unticked, for a caller whose `include` is a view.

    The changes list stops at twenty thousand rows, and it was also what built
    `include` — so on a project past that many files the save sent whichever
    twenty thousand the walk reached first and left the rest out, silently. On
    a Unity project that meant a save full of import cache with `Assets/`
    missing from it entirely.

    Present means "send everything the rules allow except these", which is
    what the changes list has always meant to the person ticking it, and makes
    the row cap a fact about the display rather than about the save. Absent
    keeps `include` exhaustive, which is what import needs: a faithful copy of
    a repository is an explicit list of paths and nothing else.
  */
  excluded?: string[];
  /** Selected paths whose absence is intentional, not a read failure. */
  deletions?: string[];
  message: string;
  projectName: string;
  /** The repository this project already maps to, if it has one. */
  repositoryId: string | null;
  /*
    The version this workspace was working from. Sending it turns publishing
    into a compare-and-swap: if somebody else saved in the meantime, their
    work is merged in rather than laid over, and a genuine clash is reported
    instead of one side quietly winning. Null means "I believe this project
    is empty"; undefined means an older client that cannot say.
  */
  expectedHeadVersionId?: string | null;
  /** The persisted Version actually materialised in this workspace. */
  baseVersionId?: string | null;
  /*
    The line this save lands on. Omitted means `main`, which is what every
    save meant before a branch could be chosen.
  */
  track?: string;
  /*
    The paths this workspace believed the project held. Without it a file
    that is in the published version but not on this disk is
    indistinguishable from one this person deleted — and treating the first
    as the second quietly drops somebody else's work.

    Undefined means the caller cannot say, and nothing is implicitly
    removed: a stale file costs a fetch, a wrongly deleted one costs work.
  */
  known?: Record<string, string>;
};

/** A file the previous version already holds, and the object behind it. */
/**
 * One file as it will be named in the version.
 *
 * Exactly one of `objectId` and `chunks` is set. Both shapes are written the
 * same way from here on, so the rest of the publish does not branch on how a
 * file happened to be stored.
 */
type PublishFile = {
  path: string;
  objectId?: string;
  /** A slice of a solid pack, for a file compressed together with others. */
  pack?: {
    packObjectId: string;
    offset: number;
    length: number;
    storedSize: number;
  };
  chunks?: Array<{ objectId: string; sourceSize: number; storedSize: number }>;
  sha256?: string;
  sourceSize: number;
  storedSize: number;
  mediaType: string;
};

/**
 * What one save is about, decided before anything is read or sent.
 *
 * Written down as a type because it is the seam between choosing and doing.
 * Ten fields is a lot to hand on, and it is honest: a save's selection really
 * is the files on disk, the ones ticked, what the project held before, what is
 * being kept by reference, and which ticked paths are missing and why. Hiding
 * that behind fewer names would not make it smaller.
 */
type Selected = {
  rules: { shared: string; local: string };
  /** Every file the rules allow, uncapped — sizes only. */
  everything: Array<{ path: string; size: number }>;
  /** Paths the caller unticked, empty when it sent an include list instead. */
  unticked: Set<string>;
  /** What this save names: ticked files plus deliberate deletions. */
  ticked: Set<string>;
  /** What the version this one continues already held, by path. */
  prior: Map<string, PriorFile>;
  /** The ticked files actually present on disk, which is what gets read. */
  sending: Array<{ path: string; size: number }>;
  /**
   * Kept from the previous version by reference, not re-sent.
   *
   * Shaped like a changed file with nothing changed, because that is what the
   * publish step below expects to receive — one list, not two kinds.
   */
  reused: Array<{
    path: string;
    sourceSize: number;
    storedSize: number;
    mediaType: string;
    added: number;
    removed: number;
    included: boolean;
    deleted: boolean;
    binary: boolean;
    lines: number;
  }>;
  deletions: Set<string>;
  /** A ticked path that could not be read, and the reason a person can act on. */
  readFailures: Map<string, string>;
  /** Ticked, not on disk, and not a deletion — reported rather than skipped. */
  vanished: string[];
};

/**
 * Everything the sending half of a save needs, gathered into one name.
 *
 * Twelve fields, and named for the same reason as Publishing: several are
 * collections keyed by path, and transposing two of them would compile.
 *
 * `uploaded` and `progress` are handed in rather than returned because the
 * stage fills them as it goes — the progress bar is read while this runs, not
 * after it.
 */
type Sending = {
  request: UploadRequest;
  repositoryId: string;
  prior: Map<string, PriorFile>;
  declarations: Declaration[];
  declarationByPath: Map<string, Declaration>;
  /** The single small changed file worth sending as a delta, when there is one. */
  deltaDeclaration: Declaration | null;
  sections: ReturnType<typeof planSections>;
  totalBytes: number;
  progress: TransferProgress;
  /** Filled as objects land, and read by the publish stage afterwards. */
  uploaded: PublishFile[];
  report: (progress: UploadProgress) => void;
};

/**
 * Everything the publishing half of a save needs, gathered into one name.
 *
 * Thirteen fields passed positionally would be a trap — two of them are Sets
 * of paths and two are Maps keyed by path, and transposing a pair would
 * compile. Named, it is also the clearest statement of where the boundary
 * lies: nothing above it has changed anything on the account.
 */
type Publishing = {
  request: UploadRequest;
  repositoryId: string;
  declarations: Declaration[];
  /** What this save sent, as the version will name it. */
  uploaded: PublishFile[];
  /** Kept from the previous version by reference. */
  reused: Selected["reused"];
  prior: Map<string, PriorFile>;
  everything: Selected["everything"];
  ticked: Set<string>;
  deletions: Set<string>;
  readFailures: Map<string, string>;
  /** Ticked, not on disk, not a deletion. */
  vanished: string[];
  totalBytes: number;
  progress: TransferProgress;
  report: (progress: UploadProgress) => void;
};

type PriorFile = {
  /** Empty for a file the previous version kept in pieces; see `chunks`. */
  objectId: string;
  /*
    The pieces of a file the previous version kept in pieces. Carried so that
    republishing an unchanged file names the same pieces again rather than
    losing them.
  */
  chunks?: Array<{ objectId: string; sourceSize: number; storedSize: number }>;
  /*
    Where a packed file lives, for the same reason chunks are carried: a file
    compressed together with others is a slice of the pack, and republishing it
    unchanged means naming that slice again.

    Missing this was not a file that failed to travel — it was an empty object
    id sent in its place, which the service refused, taking the whole version
    with it after every byte had already been stored.
  */
  pack?: { objectId: string; offset: number; length: number };
  sha256: string;
  sourceSize: number;
  storedSize: number;
  mediaType: string;
};


export class Uploader {
  private aborted = false;
  private readonly controller = new AbortController();
  /** Null until the service has been asked; see gzipAllowed. */
  private gzipSupported: boolean | null = null;
  /** Null until the service has been asked; see chunkingAllowed. */
  private chunkingSupported: boolean | null = null;
  /** Null until the service has been asked; see packingAllowed. */
  private packingSupported: boolean | null = null;
  /** Null until the service has advertised its best changed-file transport. */
  private deltaProtocol: 0 | 1 | 2 | null = null;
  /** Batch delta is separate so V2 single-file support remains compatible. */
  private deltaBatchSupported: boolean | null = null;
  private microchunkSupported: boolean | null = null;
  /** One shared preflight, so parallel upload lanes cannot race /health. */
  private capabilityRequest: Promise<{
    features: string[];
    contentEncodings: string[];
  }> | null = null;
  private telemetry = new RepositoryTelemetry();
  /*
    Planning makes the real partition and compression choices, and for a
    chunked file that means reading it: a chunk's identity is the digest of its
    bytes, and the quote has to name every one. This comment used to say the
    plan did no body I/O, which was never true, and the belief that it was is
    how the send came to do all of that reading a second time.
  */
  private planning = false;
  private plannedObjects = new Map<string, UploadObjectDefinition>();
  /**
   * Where each chunked file was cut, as the plan found it, so the send does not
   * cut it again. Keyed by path and whole-file digest: a file that changed in
   * between has a different digest, finds nothing here, and is walked afresh.
   */
  private plannedLayouts = new Map<string, ChunkLayout>();
  private plannedQuote: UploadPlan | null = null;
  /** Files sent only because git tracks them; named in the save so the service allows them. */
  private trackedByGit: string[] = [];
  /*
    Digests worked out while planning, so sending does not work them out again.

    A save runs the whole pipeline twice: the plan walks, reads, hashes and
    prices every file to produce a quote, then the send does all of it over.
    Measured on a twenty-one thousand file project, that was 42,142 hashes for
    21,071 files — the count in the profile is exactly double, which is how
    the duplication was finally noticed.

    Keyed by path and guarded by size and modification time, so a file edited
    while somebody reads the plan is hashed again rather than published under
    the digest it used to have.
  */
  /** Whether this save has already said that packing was refused. */
  private packRefusalSaid = false;

  private plannedDigests = new Map<
    string,
    { size: number; mtimeMs: number; sha256: string }
  >();

  /**
   * Every digest this save actually took, for a caller that keeps a record.
   *
   * The desktop keeps one and hands it back through `knownDigests`, which is
   * what stops an unchanged file being read twice. The command line had no
   * way to keep one because this was private, so it re-read and re-hashed
   * whole projects on every save.
   *
   * Only files that were read are in here — an entry served from the caller's
   * own record was never taken and does not need writing down again.
   */
  digestsTaken(): Map<string, { size: number; mtimeMs: number; sha256: string }> {
    return new Map(this.plannedDigests);
  }
  private planningCreatedRepositoryId: string | null = null;
  /** Attached to every object write after the server admits the exact plan. */
  private activeQuoteId: string | null = null;

  constructor(private readonly credentials: Credentials) {}

  cancel(): void {
    this.aborted = true;
    this.controller.abort();
  }

  private check(): void {
    if (this.aborted) throw new UploadCancelled();
  }

  /**
   * One request, repeated while repeating it might help.
   *
   * Everything the uploader sends passes through here, which is the only
   * reason a single change can cover all of it. The alternative — retrying at
   * each call site — is where the previous absence of retries came from:
   * every site could see that its own operation was safe to repeat, and no
   * site was responsible for repeating it.
   */
  private async call<T>(
    route: string,
    init: {
      method: string;
      body?: string | Uint8Array;
      contentType?: string;
      retryable?: boolean;
    },
  ): Promise<T> {
    let wait = RETRY_FIRST_WAIT_MS;
    for (let attempt = 1; ; attempt += 1) {
      // Cancellation beats a pending retry: a cancelled upload has to stop
      // waiting rather than serve out its backoff first.
      this.check();
      try {
        return await this.attempt<T>(route, init);
      } catch (error) {
        // Its own cancellation first: `worthRetrying` knows nothing of it.
        if (error instanceof UploadCancelled) throw error;
        // Completing a multipart upload changes server state. Repeating it can
        // replace the useful first failure with "upload is not active".
        if (init.retryable === false) throw error;
        if (attempt >= RETRY_ATTEMPTS || !worthRetrying(error)) throw error;
        this.telemetry.retry();
        await this.pause(wait);
        wait *= 2;
      }
    }
  }

  /**
   * Wait, unless the upload is cancelled while waiting.
   *
   * Jittered, because the lanes fail together. Six requests against a gateway
   * that has just gone away all fail within milliseconds of each other, and
   * six retries timed from those failures would arrive together too — which
   * turns one outage into a second one at precisely the wrong moment.
   */
  private async pause(ms: number): Promise<void> {
    try {
      await pauseFor(this.controller.signal, ms);
    } catch {
      // The signal aborted mid-wait; say so in this side's own terms.
      throw new UploadCancelled();
    }
  }

  /** A single attempt. Everything about repeating it lives in `call`. */
  private async attempt<T>(
    route: string,
    init: {
      method: string;
      body?: string | Uint8Array;
      contentType?: string;
      retryable?: boolean;
    },
  ): Promise<T> {
    const started = performance.now();
    const token = await this.credentials.token();
    if (!token) throw new Error("Sign in again before uploading");
    const response = await fetch(`${this.credentials.origin()}${route}`, {
      method: init.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "CodeRook/0.1",
        ...clientHeaders(),
        ...(this.activeQuoteId
          ? { "x-coderook-upload-quote": this.activeQuoteId }
          : {}),
        ...(init.contentType ? { "content-type": init.contentType } : {}),
      },
      body: init.body,
      /*
        The upload's own cancellation, and a deadline.

        This carried only the cancel signal, so a request the service never
        answered waited for ever: a real save of a 38,913-file project stopped
        dead with one open connection, no bytes moving either way and no CPU,
        and nothing anywhere said so. `worthRetrying` has always named "a
        request that timed out" as the case worth repeating — there was simply
        no way for one to time out, so the branch could not be reached.

        Generous on purpose. The service legitimately spends tens of seconds
        on a large batch, and a deadline tight enough to cut that short would
        turn slow saves into failing ones.
      */
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(REQUEST_DEADLINE_MS),
      ]),
    });
    const text = await response.text();
    this.telemetry.request(
      route.split("?")[0] ?? route,
      init.body,
      new TextEncoder().encode(text).byteLength,
      performance.now() - started,
    );
    this.telemetry.memory(process.memoryUsage().rss);
    if (!response.ok) {
      /*
        Parsed only when it looks like JSON. An edge failure serves an HTML
        page, and parsing that unconditionally raised `Unexpected token '<'`
        — which names the parser rather than the 502 behind it, and sends you
        looking in entirely the wrong place.
      */
      let body: { error?: { message?: string; code?: string } } = {};
      if (text.trimStart().startsWith("{")) {
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          body = {};
        }
      }
      const message =
        body.error?.message ?? `${route} failed (${response.status})`;
      /*
        The service says what kind of failure this is, and callers need that
        to say anything useful — "someone else saved first" deserves a
        different suggestion from "the disk is full". Carrying the code on the
        error keeps them from matching on wording, and is what lets
        `worthRetrying` tell a refusal apart from a hiccup.
      */
      throw Object.assign(new Error(message), {
        code: typeof body.error?.code === "string" ? body.error.code : "",
        status: response.status,
      });
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      /*
        A 200 carrying something that is not JSON is not an answer — it is
        almost always an edge page served in place of the service. Thrown
        without a status so it is treated as a connection that produced
        nothing, which is what it is.
      */
      throw new Error(`${route} returned a malformed reply`);
    }
  }

  /**
   * Perform the complete local compaction pass and ask the service whether its
   * exact physical result fits. No object body is sent by this method.
   */
  async plan(
    request: UploadRequest,
    report: (progress: UploadProgress) => void,
  ): Promise<UploadPlan> {
    this.planning = true;
    this.packRefusalSaid = false;
    this.activeQuoteId = null;
    this.plannedQuote = null;
    this.planningCreatedRepositoryId = null;
    this.plannedObjects.clear();
    this.plannedLayouts.clear();
    try {
      await this.runPass(request, report);
      const quote = this.plannedQuote as UploadPlan | null;
      if (!quote) throw new Error("Upload planning did not finish");
      return {
        ...quote,
        repositoryCreated:
          this.planningCreatedRepositoryId === quote.repositoryId,
      };
    } catch (error) {
      if (this.planningCreatedRepositoryId) {
        await this.call(
          `/v1/repositories/${this.planningCreatedRepositoryId}`,
          { method: "DELETE" },
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      this.planning = false;
    }
  }

  /** Release a review quote, and optionally its newly-created empty project. */
  async cancelPlan(plan: UploadPlan, removeCreatedRepository = false): Promise<void> {
    await this.call(
      `/v1/repositories/${plan.repositoryId}/uploads/preflight/${plan.quoteId}`,
      { method: "DELETE" },
    );
    if (removeCreatedRepository && plan.repositoryCreated) {
      await this.call(`/v1/repositories/${plan.repositoryId}`, { method: "DELETE" });
    }
  }

  /** Plan first, then execute only the admitted immutable object set. */
  async run(
    request: UploadRequest,
    report: (progress: UploadProgress) => void,
  ): Promise<UploadResult> {
    const plan = await this.plan(request, report);
    return this.execute(request, plan, report);
  }

  /** Execute a still-active quote produced by {@link plan}. */
  async execute(
    request: UploadRequest,
    plan: UploadPlan,
    report: (progress: UploadProgress) => void,
  ): Promise<UploadResult> {
    this.activeQuoteId = plan.quoteId;
    try {
      return await this.runPass(
        { ...request, repositoryId: plan.repositoryId },
        report,
      );
    } finally {
      this.activeQuoteId = null;
    }
  }

  private rememberObject(definition: UploadObjectDefinition): string {
    this.plannedObjects.set(definition.sha256, definition);
    // Only used to let the planning pass build an in-memory candidate. It is
    // never published or sent to the service.
    return `00000000-0000-4000-8000-${definition.sha256.slice(0, 12)}`;
  }

  private definition(
    sha256: string,
    size: number,
    mediaType: string,
    encoded: Encoded,
    kind: UploadObjectDefinition["kind"] = "chunk",
    repositoryRole: UploadObjectDefinition["repositoryRole"] = "chunk",
  ): UploadObjectDefinition {
    return {
      sha256,
      size,
      storedSize: encoded.body.byteLength,
      storedSha256:
        encoded.encoding === "gzip" ? encoded.storedSha256 : sha256,
      mediaType,
      kind,
      repositoryRole,
      encoding: encoded.encoding,
    };
  }

  /**
   * What this save is going to be about: which files, and what came before.
   *
   * Lifted out of `runPass` because it answers a question of its own and
   * nothing after it changes the answer. The pass around it was one function
   * of twelve hundred lines carrying five stages, which is how a progress
   * report that reset the bar on every section header went unnoticed inside
   * it for as long as it did.
   */
  private async selectFiles(
    request: UploadRequest,
    report: (progress: UploadProgress) => void,
  ): Promise<Selected> {
    const rules = request.allowIgnored
      ? { shared: "", local: "" }
      : await readRules(request.localPath);
    /*
      What the survey keeps only because git tracks it, named for the
      service: its own check of the rules would otherwise refuse them as a
      rule this client forgot. See gitTracked.
    */
    this.trackedByGit = [];
    const tracked = request.allowIgnored ? null : await gitTracked(request.localPath);
    /*
      Surveyed, not listed.

      `changedFiles` stops after twenty thousand rows, which is right for
      something a person scrolls through and was also deciding what got
      uploaded — so a project past that many files was silently backed up in
      part, with nothing anywhere saying the rest existed. The survey has no
      cap and reads nothing but sizes, which is what makes running it over
      everything affordable.

      `onDiskNow` in particular has to be complete: it is what tells a file
      that is still here from one this workspace deliberately removed, and a
      truncated version of it would propose deleting everything the walk did
      not reach.
    */
    const everything = await timed("survey the project", () =>
      surveyFiles(request.localPath, rules, (found) =>
        /*
          The walk is the first minute of a large save and said nothing at
          all, so the panel could only show 0%. A running count of what has
          been seen is not a fraction of anything — it is the evidence that
          the thing is working.
        */
        report({
          stage: "plan",
          files: found,
          totalFiles: 0,
          bytes: 0,
          totalBytes: 0,
          path: "Looking through the folder",
          /*
            Between the key check and the reading, and it holds its own place
            on the bar rather than dropping back to nought between them.
          */
          percent: 6,
          bytesPerSecond: 0,
        }),
      ),
    );
    if (tracked) {
      const layers = await collectLayers(request.localPath, rules);
      this.trackedByGit = everything
        .map((file) => file.path)
        .filter((file) => tracked.files.has(file) && excludes(file, false, layers));
    }
    counted("files surveyed", everything.length);
    const unticked = new Set(request.excluded ?? []);
    const ticked = request.excluded
      ? new Set([
          ...everything
            .map((file) => file.path)
            .filter((path) => !unticked.has(path)),
          ...(request.deletions ?? []),
        ])
      : new Set(request.include);
    if (!ticked.size) throw new Error("Nothing is selected to upload");

    const prior = request.repositoryId
      ? await this.versionFiles(request.repositoryId, request.baseVersionId)
      : new Map<string, PriorFile>();

    // Ticked files are sent; everything else the project still has keeps the
    // copy already stored, and a file that is new but unticked is left out.
    const sending = everything.filter((file) => ticked.has(file.path));
    /*
      Everything the version already holds is kept, except what this
      workspace deliberately removed.

      "Deliberately removed" means the workspace had the file and it is now
      gone. A file it never had — because somebody else added it while this
      person was working — is not theirs to delete, and must survive their
      next save. Reading this from the disk scan alone is what silently lost
      other people's files.
    */
    const reused = retainedBasePaths(prior.keys(), ticked).map((path) => {
      const held = prior.get(path)!;
      return {
        path,
        sourceSize: held.sourceSize,
        storedSize: held.storedSize,
        mediaType: held.mediaType,
        added: 0,
        removed: 0,
        included: true,
        deleted: false,
        binary: false,
        lines: 0,
      };
    });

    /*
      A ticked path that the rescan cannot see is either a deletion or a file
      that has gone since the changes list was drawn. Deletions are meant to
      disappear; anything else silently missing from a version is data loss,
      so it is collected and reported rather than quietly skipped.
    */
    const onDisk = new Set(everything.map((file) => file.path));
    const deletions = new Set(request.deletions ?? []);
    const readFailures = new Map<string, string>();
    const vanished = [...ticked].filter(
      (chosen) => !onDisk.has(chosen) && !deletions.has(chosen),
    );
    /*
      A caller may still hold a selection drawn before the rules changed. If
      the file is on disk but absent from the filtered survey, it is excluded,
      not unreadable. Naming that distinction matters: closing applications
      cannot fix an ignore rule, while changing or removing the rule can.
    */
    for (const chosen of vanished) {
      try {
        await stat(path.join(request.localPath, chosen));
        readFailures.set(chosen, "excluded by the project's ignore rules");
      } catch (error) {
        readFailures.set(
          chosen,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return {
      rules,
      everything,
      unticked,
      ticked,
      prior,
      sending,
      reused,
      deletions,
      readFailures,
      vanished,
    };
  }

  /**
   * Every file's digest and size, which is what makes an unchanged file free.
   *
   * Its own method because it is the one stage that is purely waiting: each
   * file here is an open, a read and a close, and on Windows every open is
   * also an antivirus scan. Keeping it whole and separate is what makes the
   * lane count and the throttled reporting legible rather than buried in the
   * middle of a twelve-hundred-line pass.
   */
  private async hashSelection(
    request: UploadRequest,
    sending: Selected["sending"],
    deletions: Set<string>,
    readFailures: Map<string, string>,
    /** Ticked, not on disk, not a deletion — named in the refusal below. */
    vanished: string[],
    report: (progress: UploadProgress) => void,
  ): Promise<{ declarations: Declaration[]; totalBytes: number }> {
    // 1. Measure and hash. This is what makes an unchanged file free.
    const declarations: Declaration[] = [];
    let totalBytes = 0;
    /*
      Hashed several at a time, and reported by how many are done.

      Each file here is an open, a read and a close, and on Windows every open
      is also an antivirus scan — so this stage is waiting, not computing.
      Taken strictly one after another, a folder of twenty thousand small
      files spent a quarter of an hour in a step that moves no data at all,
      and the bar sat on 0% for the first thousand of them because it only
      ever spanned a fifth of itself across the whole stage.

      Overlapping the waits collapses them into one wait. The results are
      written into their own slots rather than pushed, because which disk read
      finishes first must not decide the order of a version's file list.
    */
    const HASH_LANES = 8;
    const measured: Array<Declaration | null> = new Array(sending.length).fill(
      null,
    );
    let hashed = 0;
    let cursor = 0;
    /** Throttled: twenty thousand sends is its own cost, and nobody reads them. */
    let told = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= sending.length) return;
        const file = sending[index]!;
        this.check();
        const full = path.join(request.localPath, file.path);
        let size: number;
        let mtimeMs: number;
        try {
          const info = await stat(full);
          size = info.size;
          mtimeMs = info.mtimeMs;
        } catch (error) {
          // Unreadable now, though it was listed a moment ago. Skipping it
          // would publish a version quietly missing a file the person chose.
          vanished.push(file.path);
          readFailures.set(
            file.path,
            error instanceof Error ? error.message : String(error),
          );
          hashed += 1;
          continue;
        }
        /*
          Hashing is the first thing that opens the file, and opening is what
          fails on a file another program holds — a database in use, a browser
          profile's LOCK, an antivirus mid-scan. On Windows those still answer
          stat() perfectly well, so the check above lets them through and the
          read below is the one that actually breaks.

          It was unguarded, so the person got a raw "EBUSY: resource busy or
          locked" naming a path they never chose to think about, instead of
          the sentence this code already writes for exactly this situation.
        */
        /*
          Read only when the file has actually moved.

          Size and modification time are the same test the changes list uses,
          and a match there means the digest already taken still describes the
          bytes. Reading is what costs; deciding not to read is free.
        */
        const remembered =
          this.plannedDigests.get(file.path) ??
          request.knownDigests?.get(file.path);
        if (
          remembered &&
          remembered.size === size &&
          remembered.mtimeMs === mtimeMs
        ) {
          measured[index] = {
            path: file.path,
            full,
            size,
            sha256: remembered.sha256,
            mediaType: mediaTypeOf(file.path),
          };
          hashed += 1;
          continue;
        }
        let digest: string;
        try {
          digest = await timed("hash files", () => digestOf(full));
        } catch (error) {
          vanished.push(file.path);
          readFailures.set(
            file.path,
            error instanceof Error ? error.message : String(error),
          );
          hashed += 1;
          continue;
        }
        this.plannedDigests.set(file.path, { size, mtimeMs, sha256: digest });
        measured[index] = {
          path: file.path,
          full,
          size,
          sha256: digest,
          mediaType: mediaTypeOf(file.path),
        };
        hashed += 1;
        const now = Date.now();
        if (now - told > 80 || hashed === sending.length) {
          told = now;
          report({
            stage: "hash",
            files: hashed,
            totalFiles: sending.length,
            bytes: 0,
            totalBytes: 0,
            path: file.path,
            /*
              Reading is the stretch from just past the walk to a fifth of
              the way through. Starting it at nought put the bar behind where
              it had already been and it went backwards between stages.
            */
            percent: 8 + Math.round((hashed / sending.length) * 12),
            bytesPerSecond: 0,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(HASH_LANES, sending.length) }, () => lane()),
    );
    for (const one of measured) {
      if (!one) continue;
      declarations.push(one);
      totalBytes += one.size;
    }

    /*
      A deletion-only save has no file to hash or upload, but it is still a
      real new Version: the retained base minus the explicitly selected path.
      Refusing it here made the object phase look healthy while preventing the
      manifest-only operation that deletion is supposed to be.
    */
    if (!declarations.length && !deletions.size) {
      throw new Error("Nothing is selected to upload");
    }

    return { declarations, totalBytes };
  }

  /**
   * The project this save goes into, made if it does not exist yet.
   *
   * Small enough to inline and worth naming anyway: it is the only step that
   * can create something on the account, and the slug collision below is the
   * reason it cannot simply be a create call.
   */
  private async ensureRepository(request: UploadRequest): Promise<string> {
    this.check();
    if (request.repositoryId) return request.repositoryId;
    const slug =
      request.projectName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "project";
    try {
      const created = await this.call<{ id: string }>("/v1/repositories", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          slug,
          displayName: request.projectName.trim() || slug,
          description: "",
          visibility: "private",
        }),
      });
      if (this.planning) this.planningCreatedRepositoryId = created.id;
      return created.id;
    } catch (error) {
      /*
        The account already has a project of this name — which happens after a
        reinstall, or when the folder has moved. Saving into it is what was
        meant; failing would strand the folder.
      */
      const existing = await this.findBySlug(slug);
      if (!existing) throw error;
      return existing;
    }
  }

  /**
   * Name the version, which is what makes everything already stored visible.
   *
   * Its own method because the two halves of a save fail differently: up to
   * here nothing on the account has changed and a retry costs only the bytes
   * that did not arrive, while past here there is a version. Keeping the
   * boundary a function call rather than a comment makes that legible.
   */
  private async publishVersion(at: Publishing): Promise<UploadResult> {
    const {
      request,
      repositoryId,
      declarations,
      uploaded,
      reused,
      prior,
      everything,
      ticked,
      deletions,
      readFailures,
      vanished,
      totalBytes,
      progress,
      report,
    } = at;
    // 4. Name the version, which is what makes the upload visible.
    this.check();
    report({
      stage: "publish",
      files: declarations.length,
      totalFiles: declarations.length,
      bytes: progress.sentBytes,
      totalBytes,
      /*
        A save, not a version.

        Sending produces a commit; it becomes a version when somebody names
        it, which happens later and on purpose. This line said "Recording the
        version" while doing neither — it was the last wording left over from
        before the two were separate, and it sat on the one screen a person
        watches to the end.
      */
      path: "Writing down what was sent",
      percent: 96,
      bytesPerSecond: progress.rate(),
    });

    // The version names everything the project holds: what was just sent,
    // plus every file that kept the object the last version pointed at.
    const contents: PublishFile[] = [
      ...uploaded,
      ...reused.map((file) => {
        const held = prior.get(file.path)!;
        /*
          Republished in the shape it was already stored in. A file kept in
          pieces names the same pieces; flattening it to one object here would
          name an object that was never created.
        */
        return {
          path: file.path,
          /*
            Republished in the shape it is stored in — all three of them. The
            packed case was missing, so an unchanged small file was declared
            with an empty object id instead of the slice it actually is.
          */
          ...(held.pack
            ? {
                /*
                  The uploader's own shape for a pack slice, which is what
                  the publish step converts to the wire. A file that came
                  back from the service is described the same way as one this
                  run packed, so the two paths converge before publishing
                  rather than at it.
                */
                pack: {
                  packObjectId: held.pack.objectId,
                  offset: held.pack.offset,
                  length: held.pack.length,
                  storedSize: held.storedSize,
                },
                sha256: held.sha256,
              }
            : held.chunks?.length
              ? { chunks: held.chunks, sha256: held.sha256 }
              : { objectId: held.objectId }),
          sourceSize: held.sourceSize,
          storedSize: held.storedSize,
          mediaType: held.mediaType,
        };
      }),
    ].sort((left, right) => left.path.localeCompare(right.path));

    /*
      Last check before the version is written: everything the person ticked
      has to be in it. Reaching this with something missing would publish a
      snapshot that silently lacked a file, which is the one failure a backup
      tool must never have.
    */
    const named = new Set(contents.map((item) => item.path));
    const dropped = [
      ...new Set([
        ...vanished,
        ...[...ticked].filter(
          (chosen) => !named.has(chosen) && !deletions.has(chosen),
        ),
      ]),
    ];
    if (dropped.length) {
      const shown = dropped.slice(0, 5).join(", ");
      const rest = dropped.length > 5 ? ` and ${dropped.length - 5} more` : "";
      const details = dropped
        .map((name) => readFailures.get(name) ? `${name}: ${readFailures.get(name)}` : "")
        .filter(Boolean)
        .slice(0, 3)
        .join("; ");
      /*
        Say what to do about it. Refusing is right — a version quietly missing
        a file somebody chose is the one failure a backup tool must never have
        — but the message stopped at the refusal, and the person is left with
        a list of paths and no idea that the fix is either closing whatever
        holds them or unticking them. Almost every case is a file another
        program has open, so that is what it says.
      */
      const excluded = dropped.some((name) =>
        readFailures.get(name)?.includes("ignore rules"),
      );
      throw new Error(
        `${dropped.length} selected file${dropped.length === 1 ? "" : "s"} could not be included, ` +
          `so nothing was saved: ${shown}${rest}. ` +
          (excluded
            ? `At least one is excluded by the project's ignore rules. Change the rules or untick it and try again. `
            : `Another program may have a file open. Close it or untick the file and try again. `) +
          `Nothing was changed on your account.` +
          (details ? ` Details: ${details}` : ""),
      );
    }

    const sourceBytes = contents.reduce((total, item) => total + item.sourceSize, 0);
    const storedBytes = contents.reduce((total, item) => total + item.storedSize, 0);

    /*
      Every object is uploaded and verified; nothing on the account points at
      them yet. Stopping here has to leave no version and no partial one — the
      objects are immutable and content-addressed, so a retry reuses them.
    */
    maybeFail("submit:after-objects");

    const completed = await timed("publish the version", () => this.call<{
      version: {
        id: string;
        sequence: number;
        sourceSize?: number;
        storedSize?: number;
        /*
          A project can hold pushes from anybody below admin until an admin
          accepts them. The save worked and the bytes are stored; it is simply
          not the current version yet, and saying so is the difference between
          a person waiting and a person retrying.
        */
        state?: string;
      };
      manifest?: {
        files?: Array<{ path?: string; sha256?: string }>;
      } | null;
      repeated?: boolean;
      mergeTrack?: {
        id: string;
        reference: string;
        conflicts: Array<{ kind: string; path: string }>;
      };
    }>(`/v1/repositories/${repositoryId}/versions`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        message: request.message.trim() || "Saved from the CodeRook desktop app",
        ...(request.baseVersionId === undefined
          ? {}
          : {
              ancestryMode: "required",
              baseVersionId: request.baseVersionId,
            }),
        ...(request.expectedHeadVersionId === undefined
          ? {}
          : { expectedHeadVersionId: request.expectedHeadVersionId }),
        ...(request.track ? { track: request.track } : {}),
        ...(request.allowIgnored ? { allowIgnored: true } : {}),
        ...(this.trackedByGit.length ? { trackedByGit: this.trackedByGit } : {}),
        ...(request.allowSecrets ? { allowSecrets: true } : {}),
        ...(request.linesAdded === undefined ? {} : { linesAdded: request.linesAdded }),
        ...(request.linesRemoved === undefined
          ? {}
          : { linesRemoved: request.linesRemoved }),
        /*
          Names this attempt so a retry after a lost connection is answered
          with the version already made, rather than making a second one.
        */
        idempotencyKey: publishAttemptName({
          repositoryId,
          expectedHeadVersionId: request.expectedHeadVersionId,
          message: request.message,
          /*
            Named by what each file is. A whole file is its object; a chunked
            one is the digest of its contents — so retrying the same publish
            produces the same key either way, which is the point of it.
          */
          files: contents.map((item) => ({
            path: item.path,
            objectId: item.objectId ?? item.sha256 ?? "",
          })),
        }),
        sourceSize: sourceBytes,
        storedSize: storedBytes,
        /*
          One shape or the other, never both — the service refuses a file that
          names an object and a chunk list, and so does its database.
        */
        files: contents.map((item) => ({
          path: item.path,
          ...(item.pack
            ? {
                pack: {
                  objectId: item.pack.packObjectId,
                  offset: item.pack.offset,
                  length: item.pack.length,
                },
                sha256: item.sha256,
              }
            : item.chunks
              ? { chunks: item.chunks, sha256: item.sha256 }
              : { objectId: item.objectId }),
          sourceSize: item.sourceSize,
          storedSize: item.storedSize,
          mediaType: item.mediaType,
          executable: false,
        })),
      }),
    }));

    /*
      A clean stale-base save may contain a server-side merge. The candidate
      manifest built above is then not the Version that landed: it lacks the
      other publisher's safe changes. Persist the service's accepted snapshot
      instead. A repeated attempt predates manifest echoing, so read that
      Version once rather than guessing.
    */
    let acceptedManifest = acceptedManifestDigests(completed.manifest?.files);
    if (!completed.mergeTrack && !Object.keys(acceptedManifest).length) {
      acceptedManifest = Object.fromEntries(
        [...(await this.versionFiles(repositoryId, completed.version.id))].map(
          ([file, descriptor]) => [file, descriptor.sha256],
        ),
      );
    }

    const manifest: Record<string, string> = Object.keys(acceptedManifest).length
      ? acceptedManifest
      : {
          ...Object.fromEntries(
            reused.map((file) => [file.path, prior.get(file.path)!.sha256]),
          ),
          ...Object.fromEntries(
            declarations.map((declaration) => [declaration.path, declaration.sha256]),
          ),
        };

    /*
      What this folder holds after the save. A file that was sent holds
      the bytes that were sent. Anything else keeps whatever digest was
      recorded before: an unticked edit therefore stays pending rather
      than looking saved, and a copy left stale by somebody else's merge
      stays recognisably stale rather than looking like a new edit.

      Looked up in a map rather than by searching the declarations for each
      file, which on a 47,000-file project was over a billion comparisons at
      the very end of a save.
    */
    const sentDigest = new Map(
      declarations.map((declaration) => [declaration.path, declaration.sha256]),
    );
    const onDisk = new Set(everything.map((file) => file.path));
    const local: Record<string, string> = Object.fromEntries(
      everything.flatMap((file) => {
        const sent = sentDigest.get(file.path);
        if (sent) return [[file.path, sent] as const];
        const before = request.known?.[file.path] ?? prior.get(file.path)?.sha256;
        return before ? [[file.path, before] as const] : [];
      }),
    );
    /*
      And a file deleted here that this save carried forward keeps its place.

      A plain save adds and updates, so a file somebody deleted stays in the
      version. It used to vanish from this record all the same, because the
      record was built only from what is on disk — and the next status then
      found the version holding a file this folder did not, called it
      "behind", and offered to fetch it back. The person had deleted it; the
      only thing that brought it back was being told to run `cbx get`.

      Only where the record already had it. A file that was never here — one
      somebody else's save merged into the version — has no entry to keep, so
      it stays "behind", which is exactly what it is.
    */
    for (const path of Object.keys(manifest)) {
      if (onDisk.has(path)) continue;
      const held = request.known?.[path];
      if (held) local[path] = held;
    }

    report({
      stage: "done",
      files: declarations.length,
      totalFiles: declarations.length,
      bytes: progress.sentBytes,
      totalBytes,
      path: `Version ${completed.version.sequence} saved`,
      percent: 100,
      bytesPerSecond: progress.rate(),
    });

    return {
      repositoryId,
      versionId: completed.version.id,
      sequence: completed.version.sequence,
      ...(completed.version.state === "held" ? { held: true } : {}),
      ...(completed.mergeTrack ? { mergeTrack: completed.mergeTrack } : {}),
      ...(completed.repeated ? { repeated: true } : {}),
      sourceBytes: completed.version.sourceSize ?? sourceBytes,
      storedBytes: completed.version.storedSize ?? storedBytes,
      sentBytes: progress.transferred,
      sentFiles: uploaded.length - progress.alreadyOnAccount,
      reusedFiles: reused.length,
      /** Selected, but the service already held the content. */
      alreadyStoredFiles: progress.alreadyOnAccount,
      telemetry: this.telemetry.snapshot(),
      local,
      manifest,
    };
  }

  /**
   * Put every object on the account, and record how each one was stored.
   *
   * The longest stage, and where a save spends its time. Kept whole rather
   * than split further because its parts are not independent: the delta path,
   * the solid packs, the batches and the per-file lanes are four ways of
   * answering one question, and which one a file takes is decided by the
   * section it landed in.
   *
   * Nothing here changes anything visible on the account. Objects are
   * immutable and content-addressed, so an interrupted send costs only the
   * bytes that did not arrive — which is why the version is named afterwards
   * rather than before.
   */
  private async sendObjects(at: Sending): Promise<void> {
    const {
      request,
      repositoryId,
      prior,
      /*
        Bound under a distinct name on purpose. `runSection` declares its own
        `declarations` for the section it is working on, and a progress report
        reading the shadowed one says "file 3 of 40" when the save holds
        twenty thousand.
      */
      declarations: everyDeclaration,
      declarationByPath,
      deltaDeclaration,
      sections,
      totalBytes,
      progress,
      uploaded,
      report,
    } = at;
    const smallShare = (one: (typeof sections)[number]) =>
      one.files
        .filter((file) => file.size <= BATCH_FILE_LIMIT)
        .reduce((sum, file) => sum + file.size, 0) / Math.max(one.bytes, 1);
    const batchy = sections.filter((one) => smallShare(one) >= 0.5);
    const heavy = sections.filter((one) => smallShare(one) < 0.5);
    counted("sections batched", batchy.length);
    counted("sections heavy", heavy.length);

    /*
      How many files the whole save has finished, across every section.

      The sections are an implementation detail of not holding thirty
      gigabytes in memory at once, and they were leaking into what a person
      reads: the count ran up to twenty-one thousand while reading, then reset
      to "0 of 4,000" for each section and counted up again, over and over. It
      looked like the save was starting over, repeatedly.

      One denominator for the whole save. Sections still say which one is in
      flight, in words, where that belongs.
    */
    const sectionProgress = new Map<number, number>();
    /*
      What has already been shown, so the number never goes backwards.

      Two pipelines run sections at once and each reports its own share, which
      I have now twice failed to combine into a figure that only rises — the
      count kept dropping to zero at section boundaries and reading as though
      the save had restarted. Whatever the accounting does, the panel must not
      be told a smaller number than it was told a moment ago: going backwards
      is the specific thing a person notices, and it is never information.
    */
    let shown = 0;
    const forward = (count: number): number => {
      if (count > shown) shown = count;
      return shown;
    };
    const runSection = async (section: (typeof sections)[number]) => {
      const declarations = section.files.map(
        (file) => declarationByPath.get(file.path)!,
      );
      /*
        This section's share of the one number the panel shows.

        Two pipelines run at once, so no section can report on its own behalf
        without the count lurching between them. Each records how far it has
        got and the sum is what is shown, which is the only figure that is
        true while both are moving.
      */
      const advance = (done: number): number => {
        /*
          Only ever upward.

          The workers share one iterator, so the indices arrive out of order —
          a worker holding file 5 reports after one holding file 200. Writing
          each straight in let a later, lower number undo a higher one, and
          the count sat still or fell back to zero at every section boundary,
          which is the exact stutter this was meant to remove.
        */
        const held = sectionProgress.get(section.index) ?? 0;
        if (done > held) sectionProgress.set(section.index, done);
        else if (!sectionProgress.has(section.index)) {
          sectionProgress.set(section.index, 0);
        }
        let sum = 0;
        for (const each of sectionProgress.values()) sum += each;
        return forward(sum);
      };
      report({
        stage: "upload",
        /*
          The count so far, not zero.

          This line announces a new section, and it was reporting nought files
          done — so every section boundary threw the number back to the start
          and the bar with it. Four of the five reports in this stage were
          changed to carry the running total and this one, the only one a
          person is guaranteed to see, was missed.
        */
        files: advance(0),
        totalFiles: everyDeclaration.length,
        bytes: progress.bytes(),
        totalBytes,
        path: `Section ${section.index + 1} of ${sections.length}`,
        percent: 20 + Math.round((progress.bytes() / Math.max(totalBytes, 1)) * 72),
        bytesPerSecond: progress.rate(),
      });

      /*
      Ask once what the account already holds.

      This used to be one request per file, immediately before deciding
      whether to send it — nine thousand files meant nine thousand serial
      round trips before a single byte moved, and on a folder of that size the
      asking took longer than the transfer. The answer per digest is a boolean
      and an identifier, so the whole question fits in one request.
    */
    const alreadyHeld = await timed("ask what is already held", () =>
      this.storedInBulk(
        repositoryId,
        declarations.map((one) => one.sha256),
      ),
    );

    /*
      The small files go first, packed together.

      They are the overwhelming majority by count and almost nothing by size,
      so sending them one per request is where an upload spends its time. What
      is left after this — the large files — is where bandwidth actually
      matters, and those still go one per request through the lanes below.
    */
    const missing = declarations.filter(
      (one) => !alreadyHeld.has(one.sha256),
    );
    const smallOnes = missing.filter((one) => one.size <= BATCH_FILE_LIMIT);

    // 3. Send the objects.
    /*
      What was sent, in whichever shape it was sent. A small file is one
      object; a large one is an ordered list of chunks and the digest of the
      whole, which is what gives it an identity when no single object holds it.
    */
    const batched = new Map<string, { objectId: string; size: number }>();
    /*
      Files that went up inside a solid pack. Kept apart from `batched` because
      they are named differently in the version: a slice of a pack rather than
      an object of their own.
    */
    const packedInto = new Map<
      string,
      { packObjectId: string; offset: number; length: number; storedSize: number }
    >();
    if (
      deltaDeclaration &&
      smallOnes.some((one) => one.path === deltaDeclaration.path)
    ) {
      const held = prior.get(deltaDeclaration.path)!;
      const placed = await timed("send changed-file delta", () =>
        this.putDelta(
          repositoryId,
          request.baseVersionId!,
          held,
          deltaDeclaration,
        ),
      );
      if (placed) {
        batched.set(deltaDeclaration.sha256, {
          objectId: placed.objectId,
          size: placed.storedSize,
        });
        progress.finished(deltaDeclaration.size, placed.sentBytes);
        counted("files sent as deltas", 1);
      }
    }
    const smallForPacking = smallOnes.filter(
      (one) => !batched.has(one.sha256),
    );
    if (smallForPacking.length > 1) {
      let pack: Array<{
        declaration: Declaration;
        body: Uint8Array;
        encoded: Encoded;
      }> = [];
      let packBytes = 0;
      /*
        Batches overlap rather than queue.

        Each one was sent and awaited before the next was built, so the link
        sat idle while the client read and packed the following batch, and
        again while the service stored it. Measured on four hundred kilobyte
        files, one batch at a time managed 2.52 MB/s and four at once 3.26 —
        against a line that can do 5.58.

        Bounded low: a batch holds its whole body in memory on both ends, so
        three in flight of up to twenty four megabytes is already the most
        that is reasonable to have outstanding.
      */
      const BATCH_LANES = 3;
      const flying = new Set<Promise<void>>();
      const flush = async () => {
        if (!pack.length) return;
        const taking = pack;
        pack = [];
        packBytes = 0;
        const task = (async () => {
        let exactWireBytes: number | null = null;
        try {
          /*
            Compressed together first. This is what the .cbx format is for and
            what the upload path was not using: measured on a real project,
            small files came to 42.9% of their size compressed one at a time
            and 30.2% compressed together, because a two-kilobyte file gives a
            compressor no dictionary worth having.
          */
          const packItems = taking.map((item) => ({
            declaration: item.declaration,
            body: item.body,
          }));
          const built = (await this.packingAllowed())
            ? await buildSolidPack(
                packItems.map((item) => ({
                  sha256: item.declaration.sha256,
                  body: item.body,
                })),
              )
            : null;
          const packedBytes = built ? this.frameSolidPack(built).byteLength : 0;
          const delta = built
            ? await timed("price changed-file batch", () =>
                this.putDeltaBatch(
                  repositoryId,
                  request.baseVersionId,
                  taking,
                  prior,
                  packedBytes,
                ),
              )
            : null;
          if (delta) {
            counted("files sent as delta batch", taking.length);
            exactWireBytes = delta.sentBytes;
            for (const [digest, one] of delta.objects) batched.set(digest, one);
          }
          const placed = !delta && built
            ? await timed("send packs", () =>
                this.putPack(repositoryId, packItems, built),
              )
            : null;
          if (placed) {
            counted("files sent in packs", taking.length);
            exactWireBytes = packedBytes;
            for (const [digest, one] of placed) packedInto.set(digest, one);
          } else if (!delta) {
            /*
              Not worth packing — already-compressed content, or too few files.
              They still travel together, just as separate objects.
            */
            const answer = await timed("send batches", () =>
              this.putBatch(repositoryId, taking),
            );
            counted("files sent in batches", taking.length);
            for (const [digest, one] of answer) batched.set(digest, one);
          }
        } catch (reason) {
          /*
            A refusal here is never fatal: everything in the pack is simply
            left for the ordinary path below, which sends it one at a time.
            An older deployment without this route lands here every time.

            Said once per save, not once per pack. It used to be swallowed
            outright, and when the service began refusing packs for a reason
            that also broke the fallback, the only thing anybody saw was the
            fallback's complaint about an arbitrary file — which described
            neither what went wrong nor where. One line naming the first
            refusal is what makes the next one an hour shorter to find.
          */
          if (!this.packRefusalSaid) {
            this.packRefusalSaid = true;
            console.warn(
              `Packing was refused; sending these files individually. ${String(reason).slice(0, 300)}`,
            );
          }
        }
        /*
          Only what actually landed. Counting the whole pack meant a batch the
          service refused was counted here and then sent again by the lanes
          below and counted a second time — which is how the progress bar came
          to report a hundred and twenty percent of a forty megabyte upload.
        */
        for (const item of taking) {
          const digest = item.declaration.sha256;
          if (!batched.has(digest) && !packedInto.has(digest)) continue;
          progress.finished(
            item.declaration.size,
            exactWireBytes === null ? item.encoded.body.byteLength : 0,
          );
        }
        if (exactWireBytes !== null) progress.finished(0, exactWireBytes);
        report({
          stage: "upload",
          files: advance(0),
          totalFiles: everyDeclaration.length,
          bytes: progress.bytes(),
          totalBytes,
          path: taking[taking.length - 1]!.declaration.path,
          percent:
            20 + Math.round((progress.bytes() / Math.max(totalBytes, 1)) * 72),
          bytesPerSecond: progress.rate(),
        });
        })().finally(() => flying.delete(task));
        flying.add(task);
        if (flying.size >= BATCH_LANES) await Promise.race(flying);
      };

      for (const declaration of smallForPacking) {
        this.check();
        let body: Uint8Array;
        try {
          body = await timed("read small files", async () =>
            new Uint8Array(await readFile(declaration.full)),
          );
        } catch {
          /* Unreadable now; the ordinary path reports it properly. */
          continue;
        }
        const allowGzip = await this.gzipAllowed();
        const encoded = await timed("compress small files", () =>
          encodeForUpload(body, declaration.path, allowGzip),
        );
        if (
          pack.length >= BATCH_COUNT ||
          packBytes + encoded.body.byteLength > BATCH_BYTES
        ) {
          await flush();
        }
        pack.push({ declaration, body, encoded });
        packBytes += encoded.body.byteLength;
      }
      await flush();
      await Promise.all(flying);
    }

    /*
      Several files at once, rather than one at a time.

      Every file costs at least one round trip, and they were taken strictly
      in order — so the transfer ran at one file per latency, no matter how
      much bandwidth was free. On a folder of thousands of small files that is
      the whole cost of the upload: the network is idle between each one.

      Bounded, because the opposite mistake is worse. Thousands of concurrent
      requests would exhaust sockets, defeat the service's own rate limits and
      make a failure impossible to attribute.
    */
    const queue = declarations.entries();
    const runWorker = async () => {
      for (const [index, declaration] of queue) {
      this.check();
      report({
        stage: "upload",
        files: advance(index),
        totalFiles: everyDeclaration.length,
        bytes: progress.bytes(),
        totalBytes,
        path: declaration.path,
        percent:
          20 + Math.round((progress.bytes() / Math.max(totalBytes, 1)) * 72),
        bytesPerSecond: progress.rate(),
      });

      /*
        Content the service already holds does not need sending. Asking costs
        one round trip and saves the whole file — which after an interrupted
        save is the difference between re-uploading a project and re-uploading
        nothing.
      */
      /*
        A large file goes up in pieces, cut where its own content says.

        This is what CBX is for and what it was never doing on the wire. The
        boundaries come from the same chunker the .cbx bundle uses, so an
        edit in the middle of a large file leaves the chunks either side of it
        untouched — and an untouched chunk is one the service already holds,
        which costs a question rather than a transfer. A small file is left
        whole: cutting it up would trade one request for several and save
        nothing.
      */
      const chunkProfile = (await this.microchunkAllowed())
        ? microchunkProfileForFileSize(declaration.size)
        : profileForFileSize(declaration.size);
      if (
        chunkProfile &&
        declaration.size >= CHUNK_THRESHOLD &&
        (await this.chunkingAllowed())
      ) {
        const pieces = await this.putChunked(
          repositoryId,
          declaration,
          chunkProfile,
          (offset) => {
            progress.lane(index, offset);
            report({
              stage: "upload",
              files: advance(index),
              totalFiles: everyDeclaration.length,
              bytes: progress.bytes(),
              totalBytes,
              path: declaration.path,
              percent:
                20 +
                Math.round((progress.bytes() / Math.max(totalBytes, 1)) * 72),
              bytesPerSecond: progress.rate(),
            });
          },
        );
        progress.laneDone(index);
        /*
          A chunk is not a file. Counting every reused piece here made a
          one-file save report a negative number of sent files. The selected
          file counts as already stored only when every one of its pieces was
          reused and no payload crossed the wire.
        */
        if (pieces.sentBytes === 0) progress.alreadyHeld();
        uploaded.push({
          path: declaration.path,
          sha256: declaration.sha256,
          chunks: pieces.chunks,
          sourceSize: declaration.size,
          storedSize: pieces.chunks.reduce((sum, one) => sum + one.storedSize, 0),
          mediaType: declaration.mediaType,
        });
        progress.finished(declaration.size, pieces.sentBytes);
        continue;
      }
      const fromPack = packedInto.get(declaration.sha256);
      if (fromPack) {
        uploaded.push({
          path: declaration.path,
          sha256: declaration.sha256,
          pack: fromPack,
          sourceSize: declaration.size,
          /* Its share of the pack, so the version's totals stay honest. */
          storedSize: fromPack.storedSize,
          mediaType: declaration.mediaType,
        });
        continue;
      }
      const fromBatch = batched.get(declaration.sha256);
      if (fromBatch) {
        uploaded.push({
          path: declaration.path,
          objectId: fromBatch.objectId,
          sourceSize: declaration.size,
          storedSize: fromBatch.size,
          mediaType: declaration.mediaType,
        });
        continue;
      }
      const alreadyStored =
        alreadyHeld.get(declaration.sha256) ??
        /*
          Only asked individually when the batch did not cover it — a digest
          that changed after the bulk question, because the file was rewritten
          while this upload was running.
        */
        (await this.findStored(repositoryId, declaration));
      if (alreadyStored) progress.alreadyHeld();
      const result =
        alreadyStored ??
        (declaration.size <= DIRECT_LIMIT
          ? await timed("send files one at a time", () =>
              this.putDirect(repositoryId, declaration),
            ).catch((error: unknown) => {
              // Naming the file turns "it failed" into something actionable.
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(`${declaration.path}: ${reason}`);
            })
          : await this.putMultipart(repositoryId, declaration, (offset) => {
              /*
                Recorded before the report reads it. Without this the bar does
                not move at all during a multipart file: `bytes()` sums the
                settled total and the open lanes, and this lane's offset is
                only in the second of those once it has been set.
              */
              progress.lane(index, offset);
              report({
                stage: "upload",
                files: advance(index),
                totalFiles: everyDeclaration.length,
                bytes: progress.bytes(),
                totalBytes,
                path: declaration.path,
                percent:
                  20 +
                  Math.round((progress.bytes() / Math.max(totalBytes, 1)) * 72),
                bytesPerSecond: progress.rate(),
              });
            }));

      progress.laneDone(index);
      uploaded.push({
        path: declaration.path,
        objectId: result.objectId,
        sourceSize: declaration.size,
        storedSize: result.size,
        mediaType: declaration.mediaType,
      });
      progress.finished(declaration.size, alreadyStored ? 0 : declaration.size);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_LANES, declarations.length) }, () =>
        runWorker(),
      ),
    );
    /* Finished, so its whole share counts — the per-file reports stop one short. */
    advance(declarations.length);
    };

    const pipeline = async (queue: typeof sections) => {
      for (const section of queue) {
        this.check();
        await runSection(section);
      }
    };
    await Promise.all([pipeline(batchy), pipeline(heavy)]);
  }

  private async runPass(
    request: UploadRequest,
    report: (progress: UploadProgress) => void,
  ): Promise<UploadResult> {
    this.telemetry = new RepositoryTelemetry();
    // A version is a snapshot, not a delta, so it has to name every file in
    // the project — not merely the ones being sent this time. Anything
    // unchanged keeps the object the previous version already pointed at.
    /*
      An import filters nothing. The rules keep local mess out of a working
      folder, but an imported tree is exactly what the source repository
      tracked — there is no mess in it, and anything the source tracked in
      spite of its own rules (which git does, for files committed before the
      rule) would otherwise be dropped without being mentioned.
    */
    /*
      Chosen first, and separately: which files this save is about, what the
      project held before it, and what a ticked path that is no longer on disk
      means. Nothing below changes any of it.
    */
    const {
      everything,
      ticked,
      prior,
      sending,
      reused,
      deletions,
      readFailures,
      vanished,
    } = await this.selectFiles(request, report);
    /*
      Read once, here. Everything below works from the declarations rather
      than from the disk.
    */
    const hashed = await this.hashSelection(
      request,
      sending,
      deletions,
      readFailures,
      vanished,
      report,
    );
    /*
      A file that is exactly what the last version held is kept, not sent.

      Both callers select everything — the command line says so with an empty
      exclusion list, because its list of changes stops at twenty thousand —
      and a selected file used to be a file to send. Most of a project is
      small files, and small files are stored inside packs, so the service
      cannot recognise one as already held; the whole lot was packed again and
      sent again on every save. CodeBox's own saves sent 3.1 MB across 1,025
      files to record a change to eight.

      The digest has just been taken, so the comparison is exact: same path,
      same bytes, and the previous version's object for them — a pack slice,
      its chunks, or a plain object — is named again instead.
    */
    const keptAsItWas = (declaration: Declaration): boolean => {
      const was = prior.get(declaration.path);
      return (
        !!was &&
        was.sha256 === declaration.sha256 &&
        !deletions.has(declaration.path) &&
        !!(was.pack?.objectId || was.chunks?.length || was.objectId)
      );
    };
    const declarations = hashed.declarations.filter((one) => !keptAsItWas(one));
    let totalBytes = hashed.totalBytes;
    for (const one of hashed.declarations) {
      if (!keptAsItWas(one)) continue;
      totalBytes -= one.size;
      const held = prior.get(one.path)!;
      reused.push({
        path: one.path,
        sourceSize: held.sourceSize,
        storedSize: held.storedSize,
        mediaType: held.mediaType,
        added: 0,
        removed: 0,
        included: true,
        deleted: false,
        binary: false,
        lines: 0,
      });
    }
    counted("files kept as they were", hashed.declarations.length - declarations.length);
    // 2. The project needs somewhere on the account to live.
    const repositoryId = await this.ensureRepository(request);

    // Learn the wire contract once, before the two section pipelines begin.
    // Otherwise their first feature questions race each other and a busy
    // service can make one lane cache a false "unsupported" answer.
    await this.serviceCapabilities();

    /*
      Sent in sections, not in one attempt.

      A section is a bounded amount of work — a few hundred megabytes, or a few
      thousand files, whichever comes first — and each one finishes before the
      next begins. A small project is a single section and behaves exactly as
      it did; a thirty gigabyte one is many, and holds no more at a time than
      the small one does.

      The sections are planned from the survey rather than discovered as the
      upload goes, so the size and shape of the work are known before a byte
      moves, and a resumed upload plans the same sections in the same order.
    */
    const declarationByPath = new Map(
      declarations.map((one) => [one.path, one]),
    );
    /*
      The narrow first use of the delta transport.

      One changed small file used to miss solid packing (which correctly
      requires a group) and upload its complete compressed bytes. When more
      than one small file changes, the existing pack remains the better
      answer and is deliberately untouched. New files have no receiver base
      and also stay on the existing path.
    */
    const logicallyChanged = declarations.filter(
      (one) => prior.get(one.path)?.sha256 !== one.sha256,
    );
    const deltaDeclaration =
      logicallyChanged.length === 1 &&
      request.baseVersionId &&
      prior.has(logicallyChanged[0]!.path) &&
      logicallyChanged[0]!.size <= BATCH_FILE_LIMIT &&
      logicallyChanged[0]!.size <= DELTA_MAX_FILE_BYTES &&
      prior.get(logicallyChanged[0]!.path)!.sourceSize <= DELTA_MAX_FILE_BYTES
        ? logicallyChanged[0]!
        : null;
    const sections = planSections(
      declarations.map((one) => ({ path: one.path, size: one.size })),
    );
    counted("sections planned", sections.length);

    const uploaded: PublishFile[] = [];
    /*
      Every number a person watches during a save comes from here. It used to
      be four loose counters and two closures in the middle of this function,
      which is where the backwards bar and the "10 B/s" reading both came from
      — see the note on TransferProgress.
    */
    const progress = new TransferProgress();

    /*
      Two pipelines, not one queue.

      The sections were run one after another, and they do not compete for the
      same thing: a section of small files spends about three seconds per batch
      waiting on the service — measured, and independent of how many objects
      the batch holds — while a section of large files is limited by the link.
      One leaves bandwidth idle; the other cannot use any more.

      So they run together. Each pipeline takes the next section of its own
      kind, and when one runs out it stops rather than stealing from the other,
      because that would put two bandwidth-bound pipelines against a link that
      is already saturated by one.
    */
    /*
      Classified by where the bytes are, not by whether every file qualifies.

      Requiring every file to be small put one large file in charge of a whole
      section: on a four gigabyte game it left three sections in one pipeline
      and eighteen in the other, which is not two pipelines. Judging by the
      share of bytes that will be batched splits the same game nine and twelve.
    */
    await this.sendObjects({
      request,
      repositoryId,
      prior,
      declarations,
      declarationByPath,
      deltaDeclaration,
      sections,
      totalBytes,
      progress,
      uploaded,
      report,
    });



    if (this.planning) {
      report({
        stage: "publish",
        files: declarations.length,
        totalFiles: declarations.length,
        bytes: progress.sentBytes,
        totalBytes,
        path: "Checking storage and monthly allowance",
        percent: 96,
        bytesPerSecond: 0,
      });
      this.plannedQuote = await timed("ask the service to price it", () =>
        this.call<UploadPlan>(
        `/v1/repositories/${repositoryId}/uploads/preflight`,
        {
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify({
            sourceBytes: totalBytes,
            excludedBytes: 0,
            objects: [...this.plannedObjects.values()],
            /* So a protected line is refused before anything is sent. */
            track: request.track ?? "main",
          }),
        },
      ));
      return {
        repositoryId,
        versionId: "",
        sequence: 0,
        sourceBytes: totalBytes,
        storedBytes: this.plannedQuote.compactedBytes,
        sentBytes: this.plannedQuote.chargeableBytes,
        sentFiles: Object.values(this.plannedQuote.objects).filter(
          (object) => object.needsUpload,
        ).length,
        reusedFiles: reused.length,
        alreadyStoredFiles: 0,
        manifest: {},
        local: {},
        telemetry: this.telemetry.snapshot(),
      };
    }


    return this.publishVersion({
      request,
      repositoryId,
      declarations,
      uploaded,
      reused,
      prior,
      everything,
      ticked,
      deletions,
      readFailures,
      vanished,
      totalBytes,
      progress,
      report,
    });
  }

  /** What the newest version holds, so unchanged files can point at it. */
  private async versionFiles(
    repositoryId: string,
    versionId?: string | null,
  ): Promise<Map<string, PriorFile>> {
    const held = new Map<string, PriorFile>();
    try {
      // Explicit null is a genuinely empty base. Undefined belongs only to
      // legacy callers, which retain their historical newest-Version lookup.
      if (versionId === null) return held;
      let wanted = versionId;
      if (wanted === undefined) {
        const versions = await this.call<{
          versions?: Array<{ id?: string; sequence?: number }>;
        }>(`/v1/repositories/${repositoryId}/versions`, { method: "GET" });
        wanted = (versions.versions ?? [])[0]?.id;
      }
      if (!wanted) return held;
      const body = await this.call<{
        files?: Array<Record<string, unknown>>;
      }>(`/v1/repositories/${repositoryId}/versions/${wanted}/files`, {
        method: "GET",
      });
      for (const row of body.files ?? []) {
        const pieces = Array.isArray(row.chunks)
          ? (row.chunks as Array<Record<string, unknown>>).map((chunk) => ({
              objectId: String(chunk.objectId ?? ""),
              sourceSize: Number(chunk.sourceSize ?? 0),
              storedSize: Number(chunk.storedSize ?? 0),
            }))
          : undefined;
        const packed = row.pack as
          | { objectId?: unknown; offset?: unknown; length?: unknown }
          | undefined;
        held.set(String(row.path ?? ""), {
          objectId: String(row.objectId ?? ""),
          ...(packed?.objectId
            ? {
                pack: {
                  objectId: String(packed.objectId),
                  offset: Number(packed.offset ?? 0),
                  length: Number(packed.length ?? 0),
                },
              }
            : {}),
          ...(pieces?.length ? { chunks: pieces } : {}),
          sha256: String(row.sha256 ?? ""),
          sourceSize: Number(row.sourceSize ?? 0),
          storedSize: Number(row.storedSize ?? 0),
          mediaType: String(row.mediaType ?? "application/octet-stream"),
        });
      }
    } catch {
      // Without the previous list the version can still be written; it will
      // simply contain only what is being sent now.
    }
    return held;
  }

  /** The account's repository with this slug, if it has one. */
  private async findBySlug(slug: string): Promise<string | null> {
    try {
      const body = await this.call<{
        repositories?: Array<{ id?: string; slug?: string }>;
      }>("/v1/repositories", { method: "GET" });
      const found = (body.repositories ?? []).find((row) => row.slug === slug);
      return found?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The stored object for this content, when the service already has it.
   *
   * A miss is the ordinary case and must be cheap, so it is one request that
   * carries no body either way. Any failure answers "not stored" rather than
   * throwing: this is an optimisation, and it must never be the reason a save
   * does not happen.
   */
  private async findStored(
    repositoryId: string,
    declaration: Declaration,
  ): Promise<{ objectId: string; size: number } | null> {
    try {
      const token = await this.credentials.token();
      if (!token) return null;
      const response = await fetch(
        `${this.credentials.origin()}/v1/repositories/${repositoryId}` +
          `/stored?sha256=${declaration.sha256}`,
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": "CodeRook/0.1",
            ...clientHeaders(),
          },
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        stored?: boolean;
        objectId?: string;
        storedSize?: number;
      };
      if (!body.stored || !body.objectId) return null;
      return { objectId: body.objectId, size: Number(body.storedSize ?? 0) };
    } catch {
      return null;
    }
  }

  /**
   * Send many small files compressed together as one pack.
   *
   * Returns where each file ended up inside the stored pack, or null if the
   * service would not take it — in which case the caller falls back to sending
   * them separately, which is slower and larger but always works.
   */
  private async putPack(
    repositoryId: string,
    items: Array<{ declaration: Declaration; body: Uint8Array }>,
    alreadyBuilt?: SolidPack,
  ): Promise<Map<
    string,
    { packObjectId: string; offset: number; length: number; storedSize: number }
  > | null> {
    const built = alreadyBuilt ?? await buildSolidPack(
      items.map((item) => ({
        sha256: item.declaration.sha256,
        body: item.body,
      })),
    );
    if (!built) return null;
    const packed = this.frameSolidPack(built);

    if (this.planning) {
      const objectId = this.rememberObject({
        sha256: built.sha256,
        size: built.size,
        storedSize: built.body.byteLength,
        storedSha256: built.storedSha256,
        mediaType: "application/octet-stream",
        kind: "solid_pack",
        repositoryRole: "bundle",
        encoding: "gzip",
      });
      const placed = new Map<
        string,
        { packObjectId: string; offset: number; length: number; storedSize: number }
      >();
      for (const member of built.members) {
        placed.set(member.sha256, {
          packObjectId: objectId,
          offset: member.offset,
          length: member.length,
          storedSize: built.size
            ? Math.round((member.length / built.size) * built.body.byteLength)
            : 0,
        });
      }
      return placed;
    }

    const answer = await this.call<{ packObjectId: string; storedSize: number }>(
      `/v1/repositories/${repositoryId}/objects/pack`,
      {
        method: "POST",
        contentType: "application/octet-stream",
        body: packed,
      },
    );
    const placed = new Map<
      string,
      { packObjectId: string; offset: number; length: number; storedSize: number }
    >();
    /*
      Each file's share of what the pack actually costs.

      A packed file has no stored size of its own — the pack was charged once
      for all of them — but a version still has to say what it costs, and
      reporting each file's uncompressed length made a pack that halved the
      storage look like it had saved nothing. Apportioned by length, so the
      shares add up to the pack and the totals stay true.
    */
    const compressed = Number(answer.storedSize) || built.body.byteLength;
    for (const member of built.members) {
      placed.set(member.sha256, {
        packObjectId: answer.packObjectId,
        offset: member.offset,
        length: member.length,
        storedSize: built.size
          ? Math.round((member.length / built.size) * compressed)
          : 0,
      });
    }
    return placed;
  }

  /** The exact HTTP body used for the solid-pack alternative. */
  private frameSolidPack(built: SolidPack): Uint8Array {
    const manifestBytes = new TextEncoder().encode(JSON.stringify({
      sha256: built.sha256,
      storedSha256: built.storedSha256,
      size: built.size,
      members: built.members,
    }));
    const packed = new Uint8Array(
      4 + manifestBytes.byteLength + built.body.byteLength,
    );
    new DataView(packed.buffer).setUint32(0, manifestBytes.byteLength, false);
    packed.set(manifestBytes, 4);
    packed.set(built.body, 4 + manifestBytes.byteLength);
    return packed;
  }

  /**
   * Price several independent file deltas against the already-built solid
   * pack. The batch is optional and may only replace the pack when every
   * member has an immutable base and the complete two-way wire cost wins by
   * the same twenty-percent margin used by the single-file transport.
   */
  private async putDeltaBatch(
    repositoryId: string,
    baseVersionId: string | null | undefined,
    items: Array<{ declaration: Declaration; body: Uint8Array; encoded: Encoded }>,
    prior: Map<string, PriorFile>,
    solidPackBytes: number,
  ): Promise<{
    objects: Map<string, { objectId: string; size: number }>;
    sentBytes: number;
  } | null> {
    if (
      !baseVersionId ||
      solidPackBytes <= 0 ||
      items.length < 2 ||
      items.length > DELTA_BATCH_MAX_FILES ||
      !(await this.deltaBatchAllowed())
    ) return null;
    let sourceBytes = 0;
    let signatureEstimate = 6 + items.length * 4;
    const bases: PriorFile[] = [];
    for (const item of items) {
      const base = prior.get(item.declaration.path);
      if (
        !base ||
        !base.sha256 ||
        item.declaration.size > DELTA_MAX_FILE_BYTES ||
        base.sourceSize > DELTA_MAX_FILE_BYTES
      ) return null;
      if (
        createHash("sha256").update(item.body).digest("hex") !==
        item.declaration.sha256
      ) return null;
      sourceBytes += item.declaration.size;
      if (sourceBytes > DELTA_BATCH_MAX_SOURCE_BYTES) return null;
      signatureEstimate += estimateDeltaSignatureBytes(base.sourceSize, 2);
      bases.push(base);
    }
    if (signatureEstimate >= solidPackBytes * 0.8) return null;

    try {
      const token = await this.credentials.token();
      if (!token) return null;
      const response = await fetch(
        `${this.credentials.origin()}/v1/repositories/${repositoryId}/objects/delta/signatures`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.coderook.delta-signature-batch; version=2",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "CodeRook/0.1",
            ...clientHeaders(),
          },
          body: JSON.stringify({
            baseVersionId,
            files: items.map((item, index) => ({
              path: item.declaration.path,
              baseSha256: bases[index]!.sha256,
            })),
          }),
          signal: this.controller.signal,
        },
      );
      if (!response.ok) return null;
      const signatureBytes = new Uint8Array(await response.arrayBuffer());
      const signatures = decodeDeltaSignatureBatch(signatureBytes);
      if (signatures.length !== items.length) return null;
      const framed = encodeDeltaBatchEnvelope({
        baseVersionId,
        entries: items.map((item, index) => ({
          path: item.declaration.path,
          sha256: item.declaration.sha256,
          mediaType: item.declaration.mediaType,
          patch: createDeltaPatch(item.body, signatures[index]!),
        })),
      });
      const wireBytes = signatureBytes.byteLength + framed.byteLength;
      if (wireBytes >= solidPackBytes * 0.8) return null;
      if (this.planning) {
        const objects = new Map<string, { objectId: string; size: number }>();
        for (const item of items) {
          const definition = this.definition(
            item.declaration.sha256,
            item.body.byteLength,
            item.declaration.mediaType,
            item.encoded,
          );
          objects.set(item.declaration.sha256, {
            objectId: this.rememberObject(definition),
            size: definition.storedSize,
          });
        }
        return { objects, sentBytes: wireBytes };
      }
      const answer = await this.call<{
        objects: Array<{
          objectId: string;
          sha256: string;
          storedSize: number;
        }>;
      }>(`/v1/repositories/${repositoryId}/objects/delta/batch`, {
        method: "POST",
        contentType: "application/octet-stream",
        body: framed,
      });
      if (answer.objects.length !== items.length) return null;
      const objects = new Map<string, { objectId: string; size: number }>();
      for (const object of answer.objects) {
        if (!items.some((item) => item.declaration.sha256 === object.sha256)) {
          return null;
        }
        objects.set(object.sha256, {
          objectId: object.objectId,
          size: object.storedSize,
        });
      }
      const expectedDigests = new Set(
        items.map((item) => item.declaration.sha256),
      ).size;
      return objects.size === expectedDigests
        ? { objects, sentBytes: wireBytes }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Try the negotiated receiver-signature transport for one changed file.
   *
   * Any refusal, old deployment, stale base, or poor result returns null and
   * the caller sends the complete object exactly as it did before. The patch
   * is never a repository object: the service reconstructs and verifies the
   * complete target before returning the ordinary object id used below.
   */
  private async putDelta(
    repositoryId: string,
    baseVersionId: string,
    prior: PriorFile,
    declaration: Declaration,
  ): Promise<{
    objectId: string;
    storedSize: number;
    sentBytes: number;
  } | null> {
    const deltaVersion = await this.deltaVersion();
    if (deltaVersion === 0) return null;
    let target: Uint8Array;
    try {
      target = new Uint8Array(await readFile(declaration.full));
    } catch {
      return null;
    }
    const digest = createHash("sha256").update(target).digest("hex");
    if (digest !== declaration.sha256) return null;

    const ordinary = await encodeForUpload(
      target,
      declaration.path,
      await this.gzipAllowed(),
    );
    const signatureEstimate = estimateDeltaSignatureBytes(
      prior.sourceSize,
      deltaVersion,
    );
    if (signatureEstimate >= ordinary.body.byteLength * 0.8) return null;

    try {
      const signatureBytes = await this.deltaSignature(
        repositoryId,
        baseVersionId,
        declaration.path,
        prior.sha256,
        deltaVersion,
      );
      const signature = parseDeltaSignature(signatureBytes);
      const patch = createDeltaPatch(target, signature);
      let framed: Uint8Array;
      if (signature.version === 2) {
        framed = encodeDeltaEnvelope({
          baseVersionId,
          path: declaration.path,
          sha256: declaration.sha256,
          mediaType: declaration.mediaType,
          patch,
        });
      } else {
        const manifest = new TextEncoder().encode(
          JSON.stringify({
            baseVersionId,
            path: declaration.path,
            baseSha256: prior.sha256,
            sha256: declaration.sha256,
            size: target.byteLength,
            mediaType: declaration.mediaType,
          }),
        );
        framed = new Uint8Array(4 + manifest.byteLength + patch.byteLength);
        new DataView(framed.buffer).setUint32(0, manifest.byteLength, false);
        framed.set(manifest, 4);
        framed.set(patch, 4 + manifest.byteLength);
      }

      // Count both directions. A patch that only looks small because its
      // receiver signature was ignored is not an improvement.
      const wireBytes = signatureBytes.byteLength + framed.byteLength;
      if (wireBytes >= ordinary.body.byteLength * 0.8) return null;
      if (this.planning) {
        const definition = this.definition(
          declaration.sha256,
          target.byteLength,
          declaration.mediaType,
          ordinary,
        );
        return {
          objectId: this.rememberObject(definition),
          storedSize: definition.storedSize,
          sentBytes: wireBytes,
        };
      }
      const answer = await this.call<{
        objectId: string;
        storedSize: number;
      }>(`/v1/repositories/${repositoryId}/objects/delta`, {
        method: "POST",
        contentType: "application/octet-stream",
        body: framed,
      });
      return {
        objectId: answer.objectId,
        storedSize: answer.storedSize,
        sentBytes: wireBytes,
      };
    } catch {
      // This is an optional transport. The complete-object path is authority.
      return null;
    }
  }

  private async deltaSignature(
    repositoryId: string,
    baseVersionId: string,
    filePath: string,
    baseSha256: string,
    version: 1 | 2,
  ): Promise<Uint8Array> {
    const token = await this.credentials.token();
    if (!token) throw new Error("Sign in again before uploading");
    const response = await fetch(
      `${this.credentials.origin()}/v1/repositories/${repositoryId}/objects/delta/signature`,
      {
        method: "POST",
        headers: {
          accept: `application/vnd.coderook.delta-signature; version=${version}`,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "CodeRook/0.1",
          ...clientHeaders(),
        },
        body: JSON.stringify({ baseVersionId, path: filePath, baseSha256 }),
        signal: this.controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Delta signature failed with HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Send many small objects in one request.
   *
   * Returns what landed, keyed by digest. Anything the service could not take
   * is simply absent, and the caller sends those the ordinary way — these are
   * content-addressed, so a retry is free and a partial batch costs nothing
   * but the objects it missed.
   */
  private async putBatch(
    repositoryId: string,
    items: Array<{ declaration: Declaration; body: Uint8Array; encoded: Encoded }>,
  ): Promise<Map<string, { objectId: string; size: number }>> {
    const landed = new Map<string, { objectId: string; size: number }>();
    if (!items.length) return landed;

    const manifest = JSON.stringify({
      objects: items.map((item) => ({
        sha256: item.declaration.sha256,
        size: item.body.byteLength,
        storedSize: item.encoded.body.byteLength,
        mediaType: item.declaration.mediaType,
        encoding: item.encoded.encoding,
        ...(item.encoded.encoding === "gzip"
          ? { storedSha256: item.encoded.storedSha256 }
          : {}),
      })),
    });
    const manifestBytes = new TextEncoder().encode(manifest);
    const total =
      4 +
      manifestBytes.byteLength +
      items.reduce((sum, item) => sum + item.encoded.body.byteLength, 0);
    const packed = new Uint8Array(total);
    new DataView(packed.buffer).setUint32(0, manifestBytes.byteLength, false);
    packed.set(manifestBytes, 4);
    let at = 4 + manifestBytes.byteLength;
    for (const item of items) {
      packed.set(item.encoded.body, at);
      at += item.encoded.body.byteLength;
    }

    if (this.planning) {
      for (const item of items) {
        const definition = this.definition(
          item.declaration.sha256,
          item.body.byteLength,
          item.declaration.mediaType,
          item.encoded,
        );
        landed.set(item.declaration.sha256, {
          objectId: this.rememberObject(definition),
          size: definition.storedSize,
        });
      }
      return landed;
    }

    const answer = await this.call<{
      objects?: Array<{ sha256: string; objectId: string; storedSize: number }>;
    }>(`/v1/repositories/${repositoryId}/objects/batch`, {
      method: "POST",
      contentType: "application/octet-stream",
      body: packed,
    });
    for (const one of answer.objects ?? []) {
      landed.set(one.sha256, {
        objectId: one.objectId,
        size: one.storedSize,
      });
    }
    return landed;
  }

  /**
   * Which of these digests the account already holds, in one request.
   *
   * Falls back to an empty answer rather than an error: an older deployment
   * has no such route, and the per-file lookup below still works, so the
   * upload is slower and never broken.
   */
  private async storedInBulk(
    repositoryId: string,
    digests: string[],
  ): Promise<Map<string, { objectId: string; size: number }>> {
    const held = new Map<string, { objectId: string; size: number }>();
    if (!digests.length) return held;
    try {
      /*
        Split so one request stays a reasonable size on both ends. Five
        thousand digests is roughly a third of a megabyte of JSON, which is
        nothing beside the transfer it is replacing.
      */
      for (let at = 0; at < digests.length; at += 5000) {
        this.check();
        const batch = [...new Set(digests.slice(at, at + 5000))];
        const answer = await this.call<{
          stored?: Record<string, { objectId: string; storedSize: number }>;
        }>(`/v1/repositories/${repositoryId}/stored`, {
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify({ sha256: batch }),
        });
        for (const [digest, one] of Object.entries(answer.stored ?? {})) {
          held.set(digest, { objectId: one.objectId, size: one.storedSize });
        }
      }
    } catch {
      /*
        Unknown route, or a refusal. Answering "nothing is held" is always
        safe: every file is then asked about individually, exactly as before.
      */
      return new Map();
    }
    return held;
  }

  /**
   * Send one file as content-defined chunks, reusing whatever is already held.
   *
   * The boundaries come from CBX's chunker, so they depend on the bytes rather
   * than on offsets: inserting a line near the top of a large file shifts one
   * chunk instead of every chunk after it. Each piece is an ordinary
   * content-addressed object, which is what makes "the service already has
   * this one" a question the existing protocol can already answer.
   */
  private async putChunked(
    repositoryId: string,
    declaration: Declaration,
    profile: ChunkProfile,
    onOffset: (offset: number) => void,
  ): Promise<{
    chunks: Array<{ objectId: string; sourceSize: number; storedSize: number }>;
    reused: number;
    /** Bytes that actually travelled, as opposed to pieces already held. */
    sentBytes: number;
  }> {
    /*
      Three steps, and each file is read for as long as it has to be.

      This used to walk the file once, asking the service about every four
      chunks as it went and waiting for each answer before reading on — then
      the send walked it again and asked all over again. A 10.6 GB project is
      8,395 chunks: 2,099 lookups per pass, one after another, at about a
      third of a second each. Twelve minutes of waiting per pass, on a stage
      the window labels "Working out what to send", before a byte had moved.

      Now: find where the file is cut and what each piece's digest is (the plan
      does this; the send is handed the plan's answer), ask about every digest
      at once — one request per five thousand — and then read only the pieces
      that are not already held, by position, several at a time.
    */
    const key = `${declaration.path}\n${declaration.sha256}`;
    let layout = this.planning ? undefined : this.plannedLayouts.get(key);
    /*
      Walking the file is half this file's progress when it happens here and
      none of it when the plan already did it, so the bar neither jumps back
      between the two halves nor sits still through the first.
    */
    const walking = !layout;
    if (!layout) {
      layout = await this.layoutOf(declaration, profile, (offset) =>
        onOffset(Math.floor(offset / 2)),
      );
      if (this.planning) this.plannedLayouts.set(key, layout);
    }
    const already = walking ? declaration.size / 2 : 0;
    const share = walking ? 0.5 : 1;

    const chunks: Array<
      { objectId: string; sourceSize: number; storedSize: number } | undefined
    > = new Array(layout.length);
    let reused = 0;
    let sent = 0;
    let done = 0;

    const note = (kind: "reused" | "sent", bytes: number) => {
      if (kind === "reused") reused += 1;
      else sent += bytes;
    };

    /*
      Asked all at once, because nothing about the question needs the bytes.
      The old batch was capped at four because each entry held a piece in
      memory; the digests alone are sixty-four characters each.
    */
    const held = await this.storedInBulk(
      repositoryId,
      layout.map((piece) => piece.digest),
    );

    /*
      A file's chunks go up several at a time.

      They were sent strictly one after another, which meant one large file
      used exactly one lane however many were free. Measured on a gigabyte
      folder, throughput fell from 4 MB/s to 0.97 MB/s as the small files ran
      out and only the big one was left — five lanes idle while one crawled.
      For a folder that is *one* large file, that was the whole upload.

      Bounded because each lane holds one piece in memory: four in flight of
      at most a maximum chunk each.
    */
    const CHUNK_LANES = 4;
    /*
      One verdict for this file, shared by its lanes, and consulted only where
      the plan has not already decided. The send takes each chunk's encoding
      from the plan instead, because the service holds every object to exactly
      what was quoted and rejects anything else — and this verdict depends on
      which of four lanes finishes compressing first, so two passes asking it
      separately could disagree about a chunk right where it gives up.
    */
    const gzip = freshGzipVerdict();
    const pieces = layout;
    const file = await open(declaration.full, "r");
    try {
      let cursor = 0;
      const lane = async (): Promise<void> => {
        for (;;) {
          const at = cursor;
          cursor += 1;
          if (at >= pieces.length) return;
          this.check();
          const piece = pieces[at]!;
          const stored = held.get(piece.digest);
          if (stored) {
            note("reused", 0);
            chunks[at] = {
              objectId: stored.objectId,
              sourceSize: piece.length,
              storedSize: stored.size,
            };
          } else {
            const bytes = Buffer.allocUnsafe(piece.length);
            let got = 0;
            while (got < piece.length) {
              const { bytesRead } = await file.read(
                bytes,
                got,
                piece.length - got,
                piece.offset + got,
              );
              if (!bytesRead) break;
              got += bytesRead;
            }
            /*
              Checked, because the layout may be the plan's and the file may
              have been written to since without its size or time moving. The
              service would refuse the piece anyway; this says why, in words.
            */
            if (
              got !== piece.length ||
              createHash("sha256").update(bytes).digest("hex") !== piece.digest
            ) {
              throw new Error(
                `${declaration.path} changed while it was being saved. ` +
                  "Save again to send what it holds now.",
              );
            }
            await this.sendChunk(
              repositoryId,
              declaration,
              bytes,
              piece.digest,
              chunks,
              at,
              note,
              gzip,
            );
          }
          done += piece.length;
          onOffset(Math.floor(already + done * share));
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CHUNK_LANES, pieces.length) }, () => lane()),
      );
    } finally {
      await file.close();
    }
    /*
      Order is the file. Every position must be filled: a hole would mean a
      chunk that never landed, and publishing around it would produce a version
      whose bytes are individually verified and collectively wrong.

      Counted by index rather than with `some`, which skips the holes of a
      sparse array — the one thing this check exists to find — and so could
      never have fired.
    */
    for (let at = 0; at < pieces.length; at += 1) {
      if (!chunks[at]) {
        throw new Error(`${declaration.path}: a chunk did not finish uploading`);
      }
    }
    return {
      chunks: chunks as Array<{
        objectId: string;
        sourceSize: number;
        storedSize: number;
      }>,
      reused,
      sentBytes: sent,
    };
  }

  /**
   * Where a file is cut into chunks, and the digest of each piece.
   *
   * Read in windows, not all at once. This used to load the whole file to
   * chunk it, which for the files that reach this path meant an allocation the
   * size of the file: a three gigabyte video was a three gigabyte buffer and an
   * out-of-memory crash partway through an upload. The window holds at most
   * one read plus one maximum chunk, whatever the file is — exactly how cbx.ts
   * packs a bundle, and for the same reason.
   *
   * Nothing is kept but offsets and digests, so a ten gigabyte file costs a few
   * hundred kilobytes to remember between the plan and the send.
   */
  private async layoutOf(
    declaration: Declaration,
    profile: ChunkProfile,
    onScanned: (offset: number) => void,
  ): Promise<ChunkLayout> {
    const layout: ChunkLayout = [];
    const digestOf = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    let pending = Buffer.alloc(0);
    let pendingAt = 0;
    for await (const block of createReadStream(declaration.full, {
      highWaterMark: 8 * 1024 * 1024,
    })) {
      this.check();
      const incoming = Buffer.from(block as Buffer);
      pending = pending.length ? Buffer.concat([pending, incoming]) : incoming;
      let from = 0;
      for (const cut of cutPoints(pending, profile)) {
        layout.push({
          offset: pendingAt + from,
          length: cut - from,
          digest: digestOf(pending.subarray(from, cut)),
        });
        from = cut;
      }
      pendingAt += from;
      pending = Buffer.from(pending.subarray(from));
      onScanned(pendingAt);
    }
    /*
      cutPoints returns the boundaries *inside* what it was given and never the
      end, so whatever is left after the last cut is a chunk it does not
      mention — the packer in cbx.ts emits that tail itself, after its loop.
      Dropping it truncates every chunked file by exactly its last piece.
    */
    if (pending.length) {
      layout.push({ offset: pendingAt, length: pending.length, digest: digestOf(pending) });
    }
    return layout;
  }

  /** Send one chunk, reusing it if the account already holds those bytes. */
  private async sendChunk(
    repositoryId: string,
    declaration: Declaration,
    piece: Buffer,
    digest: string,
    /*
      Written at a known position rather than appended. The chunks are sent
      several at a time and finish in whatever order the network decides, but
      their order *is* the file — appending as they land would reassemble a
      large file out of sequence, which produces bytes that are all present,
      all verified individually, and wrong.
    */
    chunks: Array<
      { objectId: string; sourceSize: number; storedSize: number } | undefined
    >,
    at: number,
    note: (kind: "reused" | "sent", bytes: number) => void,
    /** This file's running verdict on compression; see {@link noteChunkOutcome}. */
    gzip: GzipVerdict,
  ): Promise<void> {
    {
      this.check();
      /*
        What the plan decided, where it decided. The quote names each object's
        encoding and the service rejects a piece that arrives any other way,
        so the send repeats the plan's answer rather than working one out. The
        same bytes with the same answer compress to the same bytes, which is
        what makes repeating it exact.
      */
      const planned = this.planning ? undefined : this.plannedObjects.get(digest);
      const encoded = await encodeForUpload(
        new Uint8Array(piece),
        declaration.path,
        planned
          ? planned.encoding === "gzip"
          : gzip.allowed && (await this.gzipAllowed()),
      );
      /*
        Read the outcome back rather than the guess. A chunk that kept gzip
        proves the file is worth compressing; a run of chunks that did not
        proves it is not, and there is no reason to ask the rest of a gigabyte.
      */
      if (!planned) noteChunkOutcome(gzip, encoded.encoding === "gzip");
      const query =
        encoded.encoding === "gzip"
          ? `?kind=chunk&role=chunk&encoding=gzip` +
            `&logicalSize=${piece.length}` +
            `&storedSha256=${encoded.storedSha256}`
          : `?kind=chunk&role=chunk`;
      if (this.planning) {
        const definition = this.definition(
          digest,
          piece.length,
          declaration.mediaType,
          encoded,
        );
        note("sent", encoded.body.byteLength);
        chunks[at] = {
          objectId: this.rememberObject(definition),
          sourceSize: piece.length,
          storedSize: definition.storedSize,
        };
        return;
      }
      const stored = await this.call<{
        objectId: string;
        size: number;
        storedSize?: number;
      }>(`/v1/repositories/${repositoryId}/objects/${digest}${query}`, {
        method: "PUT",
        contentType: "application/octet-stream",
        body: encoded.body,
      }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${declaration.path}: ${reason}`);
      });
      note("sent", encoded.body.byteLength);
      chunks[at] = {
        objectId: stored.objectId,
        sourceSize: piece.length,
        /* What the service keeps, which is smaller when the piece gzipped. */
        storedSize: stored.storedSize ?? stored.size,
      };
    }
  }

  private async putDirect(
    repositoryId: string,
    declaration: Declaration,
  ): Promise<{ objectId: string; size: number }> {
    const body = await readFile(declaration.full);
    // The file was hashed earlier, and a live file — a database, a log — can
    // change in between. The bytes about to be sent are what must be
    // described, so the digest is taken from them rather than trusted.
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== declaration.sha256) {
      declaration.sha256 = digest;
      declaration.size = body.length;
    }
    /*
      The digest in the path stays the original file's, whatever travels.

      That is the whole reason an object can be sent compressed at all: its
      identity is what it *is*, not how it was packed, so a file the service
      already holds is recognised as held even if the two clients that sent it
      made different choices about compression.
    */
    const encoded = await encodeForUpload(
      new Uint8Array(body),
      declaration.path,
      await this.gzipAllowed(),
    );
    const query =
      encoded.encoding === "gzip"
        ? `?kind=chunk&role=chunk&encoding=gzip` +
          `&logicalSize=${body.length}` +
          `&storedSha256=${encoded.storedSha256}`
        : `?kind=chunk&role=chunk`;
    if (this.planning) {
      const definition = this.definition(
        digest,
        body.length,
        declaration.mediaType,
        encoded,
      );
      return {
        objectId: this.rememberObject(definition),
        size: definition.storedSize,
      };
    }
    /*
      The answer carries both sizes and they are not the same thing: `size` is
      the file's own length, `storedSize` is what the service actually keeps.
      They agree only while nothing is compressed, which is why recording the
      wrong one went unnoticed until a compressed object was sent — and then
      the version is refused for declaring a size the object does not have.
    */
    const stored = await this.call<{
      objectId: string;
      size: number;
      storedSize?: number;
    }>(`/v1/repositories/${repositoryId}/objects/${digest}${query}`, {
      method: "PUT",
      contentType: declaration.mediaType,
      body: encoded.body,
    });
    return {
      objectId: stored.objectId,
      size: stored.storedSize ?? stored.size,
    };
  }

  /**
   * Whether this deployment records gzipped objects.
   *
   * Asked once and remembered. Sending an encoding the service cannot record
   * is refused outright, so this is not an optimisation to guess at — an older
   * deployment answers without gzip and every upload simply goes as it always
   * did.
   */
  /**
   * Whether this deployment can store a file as chunks.
   *
   * Asked rather than assumed, because the app updates on its own schedule and
   * the service updates on another: a build that started chunking against a
   * deployment without the table behind it would fail every large upload, and
   * fail it after doing all the work. An older service answers no and files go
   * up whole exactly as they always did.
   */
  private async packingAllowed(): Promise<boolean> {
    if (this.packingSupported !== null) return this.packingSupported;
    this.packingSupported = (await this.serviceFeatures()).includes(
      "solid-packs",
    );
    return this.packingSupported;
  }

  private async microchunkAllowed(): Promise<boolean> {
    if (this.microchunkSupported !== null) return this.microchunkSupported;
    this.microchunkSupported = (await this.serviceFeatures()).includes(
      "microchunk-map-v1",
    );
    return this.microchunkSupported;
  }

  private async deltaVersion(): Promise<0 | 1 | 2> {
    if (this.deltaProtocol !== null) return this.deltaProtocol;
    const features = await this.serviceFeatures();
    this.deltaProtocol = features.includes("delta-transport-v2")
      ? 2
      : features.includes("delta-transport")
        ? 1
        : 0;
    return this.deltaProtocol;
  }

  private async deltaBatchAllowed(): Promise<boolean> {
    if (this.deltaBatchSupported !== null) return this.deltaBatchSupported;
    this.deltaBatchSupported = (await this.serviceFeatures()).includes(
      "delta-batch-v2",
    );
    return this.deltaBatchSupported;
  }

  private async chunkingAllowed(): Promise<boolean> {
    if (this.chunkingSupported !== null) return this.chunkingSupported;
    this.chunkingSupported = (await this.serviceFeatures()).includes(
      "chunked-files",
    );
    return this.chunkingSupported;
  }

  /** What /health says this deployment accepts. One request per uploader. */
  private async serviceCapabilities(): Promise<{
    features: string[];
    contentEncodings: string[];
  }> {
    if (this.capabilityRequest) return this.capabilityRequest;
    this.capabilityRequest = (async () => {
      try {
        const response = await fetch(`${this.credentials.origin()}/health`, {
          headers: { accept: "application/json", ...clientHeaders() },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`health failed (${response.status})`);
        const body = (await response.json()) as {
          features?: string[];
          contentEncodings?: string[];
        };
        return {
          features: body.features ?? [],
          contentEncodings: body.contentEncodings ?? ["identity"],
        };
      } catch {
        /* Unknown is treated as unsupported: never risk a refused upload. */
        return { features: [], contentEncodings: ["identity"] };
      }
    })();
    return this.capabilityRequest;
  }

  private async serviceFeatures(): Promise<string[]> {
    return (await this.serviceCapabilities()).features;
  }

  private async gzipAllowed(): Promise<boolean> {
    if (this.gzipSupported !== null) return this.gzipSupported;
    const body = await this.serviceCapabilities();
    this.gzipSupported = body.contentEncodings.includes("gzip");
    return this.gzipSupported;
  }

  /** Files past the direct limit go up in parts under an upload session. */
  private async putMultipart(
    repositoryId: string,
    declaration: Declaration,
    onOffset: (offset: number) => void,
  ): Promise<{ objectId: string; size: number }> {
    if (this.planning) {
      const objectId = this.rememberObject({
        sha256: declaration.sha256,
        size: declaration.size,
        storedSize: declaration.size,
        storedSha256: declaration.sha256,
        mediaType: declaration.mediaType,
        kind: "chunk",
        repositoryRole: "chunk",
        encoding: "identity",
      });
      onOffset(declaration.size);
      return { objectId, size: declaration.size };
    }
    const session = await this.call<{ uploadSessionId: string; objectId: string }>(
      `/v1/repositories/${repositoryId}/uploads`,
      {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          sha256: declaration.sha256,
          size: declaration.size,
          mediaType: declaration.mediaType,
          kind: "chunk",
          repositoryRole: "chunk",
        }),
      },
    );

    let offset = 0;
    let partNumber = 1;
    try {
      while (offset < declaration.size) {
        this.check();
        const end = Math.min(declaration.size, offset + PART_SIZE);
        const part = await this.readSlice(declaration.full, offset, end);
        await this.call(
          `/v1/uploads/${session.uploadSessionId}/parts/${partNumber}`,
          {
            method: "PUT",
            contentType: "application/octet-stream",
            body: part,
          },
        );
        offset = end;
        partNumber += 1;
        onOffset(offset);
      }
      return await this.call<{ objectId: string; size: number }>(
        `/v1/uploads/${session.uploadSessionId}/complete`,
        {
          method: "POST",
          contentType: "application/json",
          body: "{}",
          retryable: false,
        },
      );
    } catch (error) {
      // A half-finished session would hold storage forever.
      await this.call(`/v1/uploads/${session.uploadSessionId}`, {
        method: "DELETE",
      }).catch(() => undefined);
      throw error;
    }
  }

  private async readSlice(
    full: string,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(full, { start, end: end - 1 })) {
      chunks.push(chunk as Buffer);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
}
