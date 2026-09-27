/** Types shared by the Electron main process and the renderer. */

/** A single line inside a diff hunk. */
export type DiffLine = {
  kind: "add" | "del" | "ctx";
  /** The line number to show; the new file's, except on a removed line. */
  number: number | null;
  /** The old file's number, which the split view needs on its left side. */
  oldNumber: number | null;
  text: string;
};

export type Hunk = {
  header: string;
  lines: DiffLine[];
};

/** One file that differs from the last saved version. */
/** One thing worth leaving out of an upload, and why. */
export type ExclusionSuggestion = {
  pattern: string;
  reason: string;
  bytes: number;
  files: number;
  /** Safe enough to arrive already ticked. Never applied without a person. */
  recommended: boolean;
};

export type ChangedFile = {
  path: string;
  added: number;
  removed: number;
  /** Unchecked rows are skipped for this version only. */
  included: boolean;
  binary: boolean;
  /** Present in the last version, gone from the folder now. */
  deleted?: boolean;
};

/** What the filter rules would do to a project, measured against real files. */
export type RuleImpact = {
  pattern: string;
  bytes: number;
  files: number;
};

export type ExcludedItem = {
  path: string;
  bytes: number;
  /** The rule that matched, or ".keep" when force-kept. */
  rule: string;
  forceKept: boolean;
};

export type RuleEvaluation = {
  uploadFiles: number;
  uploadBytes: number;
  skippedFiles: number;
  skippedBytes: number;
  keptFiles: number;
  keptBytes: number;
  impacts: RuleImpact[];
  excluded: ExcludedItem[];
  truncated: boolean;
};

/** One node of the project as a tree, for picking what to upload. */
export type TreeNode = {
  /** Relative and POSIX-separated; empty at the root. */
  path: string;
  name: string;
  directory: boolean;
  /** Bytes, rolled up for a directory. */
  size: number;
  /** File count, rolled up for a directory; 1 for a file. */
  files: number;
  children?: TreeNode[];
  /** The walk hit its limit and stopped listing here. */
  truncated?: boolean;
};

/**
 * The project's ignore rules. `.gitignore` is the shared, committed format —
 * one language for CodeRook, git, the desktop and the CLI — and personal
 * exclusions live in `.git/info/exclude` (docs/UPLOAD_POLICY.md).
 */
export type FilterRules = {
  /** The contents of .gitignore. `!` re-includes a matching path. */
  shared: string;
  /** The contents of .git/info/exclude; never shared with collaborators. */
  local: string;
};

/**
 * Whether files missing locally are deletions. The safe default adds and
 * updates only; deletions require choosing synchronize deliberately.
 */
export type SyncMode = "add-and-update" | "synchronize";

/**
 * Preferences that belong to the application rather than to a project.
 *
 * Here rather than beside the store so the renderer can name them without
 * importing anything that reaches for Electron.
 */
export type AppSettings = {
  /** Minimising hides the window to the tray instead of the taskbar. */
  minimiseToTray: boolean;
  /** "system" follows whatever the desktop is set to. */
  theme: "system" | "light" | "dark";
};

/** A project the application knows about, opened or not. */
export type Project = {
  id: string;
  name: string;
  localPath: string;
  /** Filters have been settled; the project may reach the upload screen. */
  configured: boolean;
  /**
   * The kind of project this was told it is, where somebody has said.
   *
   * Absent means the folder decides — which is right nearly always, and wrong
   * in the one case that matters: a layout the detection has never seen, or a
   * folder that looks like two things at once. Recorded rather than inferred
   * again each time, because the point of answering is not to be asked twice.
   */
  projectKind?: string | null;
  version: number;
  /**
   * The immutable Version that the files in this workspace were last
   * materialised from (or successfully published as). This must not move
   * merely because a refresh observes a newer Track head.
   */
  baseVersionId?: string | null;
  /** The newest Track head seen from the service. Informational only. */
  observedHeadVersionId?: string | null;
  lastOpenedAt: string;
  /** The repository on the account this folder saves to, once it has one. */
  remoteId?: string | null;
  /** Whether missing files count as deletions. Defaults to add-and-update. */
  syncMode: SyncMode;
  /*
    Set once somebody has looked at what this folder is about to send and said
    to send it anyway.

    Remembered per project so the offer is made once. Asking on every save
    would be the same as not asking: a prompt that appears every time is a
    prompt people learn to dismiss without reading, and the one time it
    mattered would go the same way as the rest.
  */
  sendAsItStands?: boolean;
  /*
    The line this folder saves onto. Absent means `main`, which is what every
    project meant before a branch could be chosen — so an older record needs
    no migration to keep behaving as it did.
  */
  track?: string;
};

/**
 * A project that exists on the account. It may have no local copy at all,
 * which is why this is not a Project: there is nothing here to open.
 */
export type RemoteProject = {
  id: string;
  name: string;
  slug: string;
  visibility: string;
  versionCount: number;
  fileCount: number;
  storedBytes: number;
  updatedAt: string;
  /** Whose it is, where the service said. Absent on an older answer. */
  ownerUserId?: string;
};

/** A `coderook://open/<owner>/<project>` link, resolved to the one project it names. */
export type LinkedProject = {
  project: RemoteProject;
  /** The signed-in account owns it. */
  mine: boolean;
  /** The account is one of its people, as owner or collaborator. */
  member: boolean;
};

export type WorkTree = {
  project: Project;
  branch: string;
  /** The version this machine holds, which the account may have moved past. */
  localVersion: number;
  /*
    The lines this project is saved on, and any merge waiting on a person.

    Carried with the scan rather than fetched separately, because the moment
    they matter is the moment somebody looks at what is outstanding — a save
    that diverged is on a track of its own, and until this existed the app
    reported "done" and said nothing about where it went.
  */
  tracks: Array<{
    id: string;
    name: string;
    kind: "line" | "merge";
    headVersionId: string | null;
    protected: boolean;
  }>;
  merges: Array<{
    id: string;
    reference: string;
    state: "open" | "applying" | "applied" | "cancelled";
    createdAt: string;
    conflicts: { total: number; unresolved: number };
    /** Present when this is a line proposed into another. */
    proposal?: { from: string | null; into: string | null; title: string | null };
  }>;
  files: ChangedFile[];
  /*
    How many files the rules would send, which is not always how many are
    listed above.

    `files` stops at twenty thousand rows because past that a list is not
    something anyone can read. A Unity project runs to forty-seven thousand,
    so the rail was showing a fifth of the folder while describing it as the
    whole of it — and the upload sent all of it regardless. Carrying the real
    number is what lets the rail say which of the two it is showing.
  */
  totalFiles: number;
  /** True when the changes list was cut short by the row cap, not by the rules. */
  listTruncated: boolean;
  totalBytes: number;
  updatedLabel: string;
  rules: FilterRules;
  /** Paths that look like credentials, warned about rather than hidden. */
  secrets: string[];
  syncMode: SyncMode;
  /** Personal exclusions need a repository to live in. */
  isRepository: boolean;
  /*
    What this folder looks like it holds that is not the work — a virtual
    environment, a build directory, a browser profile somebody left in it.
    Proposed only: nothing here is applied until a person accepts it, and a
    tidy folder produces an empty list rather than a default.
  */
  suggestions: ExclusionSuggestion[];
  /*
    Starter rules this folder's own .gitignore is missing, when that file is
    one this application wrote.

    The template grows — engine caches were added to it long after the first
    folders were set up — and a folder with any .gitignore uses that file and
    nothing else, so the improvement can never reach it. A real Unity project
    went on sending 45,342 files of import cache for exactly this reason, with
    the rule that would have stopped it sitting unused in the same build.

    Empty when the file is somebody's own work, because offering to add thirty
    rules to a file a person curated is not an offer.
  */
  missingStarterRules: string[];
  /** True once somebody has said to send this folder as it stands. */
  suggestionsDismissed: boolean;
  /**
   * What the account holds for this project, or null when it holds nothing.
   * `live` is false when the answer came from the offline cache.
   */
  remote: { sequence: number; files: number; live: boolean } | null;
};

/**
 * The stages an upload actually goes through, in order. These are the real
 * operations, not a decorative checklist: files are hashed, objects are sent,
 * and a version record names them.
 */
export type UploadStageKey = "plan" | "hash" | "upload" | "publish" | "done";

export type UploadProgress = {
  stage: UploadStageKey;
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  /** The file in hand, or what is happening when there is no file. */
  path: string;
  percent: number;
  bytesPerSecond: number;
};

export type UploadObjectDefinition = {
  sha256: string;
  size: number;
  storedSize: number;
  storedSha256: string;
  mediaType: string;
  kind: "chunk" | "solid_pack" | "cbx" | "manifest";
  repositoryRole: "chunk" | "bundle" | "manifest";
  encoding: "identity" | "gzip";
};

/** Exact physical upload plan admitted by the service before body transfer. */
export type UploadPlan = {
  quoteId: string;
  repositoryId: string;
  sourceBytes: number;
  excludedBytes: number;
  compactedBytes: number;
  reusableBytes: number;
  chargeableBytes: number;
  storage: { usedBytes: number; quotaBytes: number; remainingBytes: number };
  allowance: {
    exempt: boolean;
    stage: number;
    unlockedPercent: number;
    unlockedBytes: number;
    chargedBytes: number;
    reservedBytes: number;
    remainingBytes: number;
    periodStart: string;
    periodEnd: string;
    nextUnlockAt: string | null;
  };
  expiresAt: string;
  objects: Record<
    string,
    { objectId: string; storedSize: number; needsUpload: boolean }
  >;
  /** Local-only: this plan created an empty repository that cancellation may remove. */
  repositoryCreated?: boolean;
};

/** Progress for the jobs that are not uploads: bundles and downloads. */
export type TaskProgress = {
  kind: "export" | "import" | "download";
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  path: string;
  percent: number;
};

/** How an upload ended, as the workspace needs to hear it. */
import type {
  PastedFinding,
  PrivateFinding,
  ScanReach,
} from "../core/worktree";

export type UploadOutcome =
  | {
      state: "done";
      sequence: number;
      /*
        Carried through so the panel that says "saved" can also offer to name
        it and choose who may read it. Naming a version worked from the
        command line and from the website and not from here, which is the
        gap this closes.
      */
      versionId: string;
      repositoryId: string;
      /** Saved and stored, but waiting for an admin to accept it. */
      held?: boolean;
      /** The size of the whole version, not of this transfer. */
      sourceBytes: number;
      storedBytes: number;
      /** What this save actually had to send. */
      sentBytes: number;
      sentFiles: number;
      /*
        Selected to send, but the service already held the content — so
        nothing crossed the wire for them. Counted apart from `sentFiles`
        because reporting them together would overstate the work, and a save
        that sent nothing at all would otherwise read as a failure.
      */
      alreadyStoredFiles: number;
      reusedFiles: number;
      /*
        How much of the save the pasted-key scan actually read.

        Reported on success, not only on refusal, because the refusal path
        cannot reach the case that matters: a scan that stopped early and found
        nothing produces no refusal at all, so the one outcome that could
        mislead somebody into publishing a key was the one that said least.
      */
      reach?: ScanReach;
    }
  | {
      state: "merge-pending";
      reference: string;
      conflicts: Array<{ kind: string; path: string }>;
      /** The upload itself is complete and content-addressed. */
      sentBytes: number;
    }
  | { state: "cancelled" }
  /*
    Stopped before anything was sent, because the selection contains things
    that are almost never meant to be published.

    Its own state rather than a failure: nothing went wrong, and the answer is
    a decision rather than a retry. The command line has refused credentials
    this way since it had an upload path; this side sent them without a word,
    which is the worse half of the two behaviours the policy exists to
    prevent.
  */
  | {
      state: "refused";
      /** Files that are a credential by name. */
      secrets: string[];
      /** Folders that belong to a program rather than to the work. */
      shielded: PrivateFinding[];
      /** Credentials pasted into files that are not credentials. */
      pasted: PastedFinding[];
      /*
        How much of the selection the content scan actually read.

        Carried so the screen can say it rather than imply it. The scan stops
        at twenty thousand files, and on a project of forty-seven thousand it
        stopped in silence — twenty-seven thousand files never opened, behind a
        result that looked like the whole answer.
      */
      reach: ScanReach;
    }
  | { state: "failed"; message: string };

/** The signed-in account, as the API serialises it. */
export type Account = {
  id: string;
  email: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  plan: string;
  storageQuotaBytes: number;
  emailVerified: boolean;
};

/** Sign-in has three outcomes, and a second factor is one of them. */
export type SignInResult =
  | { state: "signed-in"; account: Account }
  | { state: "mfa"; challenge: string }
  | { state: "error"; message: string };

/** A label a project puts on its saves: a name and a colour. */
export type DesktopLabel = {
  id: string;
  name: string;
  colour: string;
  description: string | null;
};

/**
 * One save, as the owner sees it.
 *
 * Deliberately the working history rather than the published one: a save that
 * is held, declined, or whose files were taken down all appear, because
 * deciding what to do about them is what this list is for.
 */
export type DesktopVersion = {
  id: string;
  sequence: number;
  message: string;
  state: string;
  createdAt: string;
  fileCount: number;
  sourceSize: number;
  /*
    What a visitor calls this save, when the public side shows it at all.

    Not the same number as `sequence`: the public side counts only what it
    offers, so the third save here can be the first one out there. Absent
    means a visitor cannot see this one.
  */
  publicSequence?: number;
  /* What the save changed. Absent on anything published before it was kept. */
  linesAdded?: number;
  linesRemoved?: number;
  name?: string | null;
  notes?: string | null;
  /* Only meaningful once promoted: a version is offered or held back. */
  visibility?: "private" | "public";
  pinned?: boolean;
  displayOrder?: number | null;
  labels?: DesktopLabel[];
  removedAt?: string | null;
  removalReason?: string | null;
  reviewNote?: string | null;
  /** Whether the project is standing on this one right now. */
  head?: boolean;
  author?: { displayName?: string };
};

/** A folder in the ignored or kept list, with what took it. */
export type FilterNode = {
  path: string;
  name: string;
  files: number;
  bytes: number;
  /** In words, where we have them; absent rather than showing a pattern. */
  rule?: string;
  children?: FilterNode[];
};

/**
 * Everything the filter screen draws, answered in one pass.
 *
 * Three panels asking three questions of one folder. Asked separately they
 * drift apart — which is what the screen before this did, showing a tree that
 * claimed 47,387 files were going up beside a list of the 45,000 that were
 * not.
 */
export type FilterView = {
  /** What the folder looks like, whatever anybody has said. */
  detected: string[];
  /** What somebody said it is, or null while the folder decides. */
  chosen: string | null;
  upload: TreeNode;
  ignored: FilterNode[];
  kept: FilterNode[];
  uploadFiles: number;
  uploadBytes: number;
  skippedFiles: number;
  skippedBytes: number;
  keptFiles: number;
  keptBytes: number;
  /*
    Whether the three panels are the whole folder.

    Past three hundred thousand files the walk stops, and both the tree and
    the evaluation have carried a `truncated` flag for that all along which
    nothing ever drew. A screen whose whole job is "this is what travels"
    cannot quietly mean "this is some of what travels".
  */
  complete: boolean;
};
