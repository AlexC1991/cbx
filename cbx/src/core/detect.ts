/**
 * Looking at a folder and saying what probably should not be uploaded.
 *
 * Choosing what goes up is the part of adding a project that people get wrong,
 * and they get it wrong in one direction: a folder that has been worked in for
 * a year holds a virtual environment, a build directory, somebody's browser
 * profile and three copies of a release zip, and none of it is the work. The
 * cost is not only storage — it is a save that takes twenty minutes and can be
 * stopped outright by one file another program holds open.
 *
 * So this proposes. It never decides: everything it finds comes back as a
 * suggestion with a reason and a size, the person ticks what they agree with,
 * and a folder it recognises nothing in produces no suggestions rather than a
 * default nobody asked for. Being wrong here has to be cheap, which it is
 * exactly as long as nothing is applied without somebody saying so.
 */
import path from "node:path";

import { formatBytes } from "../shared/format.js";

/** One thing worth leaving out, and why a person would want to. */
export type Suggestion = {
  /** The rule as it would be written into .gitignore. */
  pattern: string;
  /** Shown next to the tick. Plain, and about their folder rather than ours. */
  reason: string;
  /** How much it holds, so the biggest wins are obvious. */
  bytes: number;
  /** How many files it covers. */
  files: number;
  /*
    Whether this is safe enough to arrive already ticked. Generated output and
    dependency directories are; anything that might be the work is not, and
    comes back for the person to look at.
  */
  recommended: boolean;
};

export type ScannedFile = { path: string; size: number };

type Rule = {
  /** Directory name, matched at any depth unless `atRoot`. */
  directory?: string;
  /**
   * Only where the project itself keeps it.
   *
   * An engine's output directories have ordinary names — `obj`, `Binaries`,
   * `Temp`, `Library` — and inside a project those names mean something else
   * entirely. This screen offered to leave out `Assets/Props/obj`, a folder
   * of 3D models, because `.obj` is also where a C# build writes. Matching
   * only at the root is how github/gitignore words the same rules, and for
   * the same reason.
   */
  atRoot?: boolean;
  /** File name, matched anywhere. */
  file?: string;
  /** Extension, including the dot. */
  extension?: string;
  reason: string;
  recommended: boolean;
};

/*
  Everything here is recoverable from something else in the project, or is
  another program's working state. Nothing that could be somebody's only copy
  of anything is marked recommended.
*/
const RULES: Rule[] = [
  { directory: "node_modules", reason: "Installed packages — restored by installing again", recommended: true },
  { directory: ".venv", reason: "Python virtual environment — rebuilt from requirements", recommended: true },
  { directory: "venv", reason: "Python virtual environment — rebuilt from requirements", recommended: true },
  { directory: "__pycache__", reason: "Python bytecode cache", recommended: true },
  { directory: ".pytest_cache", reason: "Test runner cache", recommended: true },
  { directory: ".mypy_cache", reason: "Type checker cache", recommended: true },
  { directory: ".ruff_cache", reason: "Linter cache", recommended: true },
  { directory: "target", reason: "Rust build output", recommended: true },
  { directory: ".next", reason: "Next.js build output", recommended: true },
  { directory: ".gradle", reason: "Gradle build state", recommended: true },
  { directory: ".terraform", reason: "Downloaded Terraform providers", recommended: true },
  /*
    Offered rather than recommended, and deliberately not in the starter
    template: a Go project that vendors its dependencies often commits them on
    purpose, so leaving them out by default would drop files the project is
    meant to carry. Worth asking about, because it is usually most of the
    files — 6,000 of 6,440 in the shape that found this.
  */
  { directory: "vendor", reason: "Vendored dependencies — often committed on purpose", recommended: false },

  /*
    Game engines, which is where the size actually is.

    A Unity project is mostly not the project: `Library/` alone is routinely
    thousands of times the size of `Assets/`, and every byte of it is rebuilt
    from `Assets/` and `Packages/` the next time the editor opens. Until these
    existed a Unity folder produced no suggestions at all — the one shape of
    project where the question "what should I leave out?" has the largest
    possible answer was the one the detector had nothing to say about.
  */
  { directory: "Library", atRoot: true, reason: "Unity's import cache — rebuilt when the project next opens", recommended: true },
  { directory: "Temp", atRoot: true, reason: "Unity's scratch folder for the running editor", recommended: true },
  { directory: "MemoryCaptures", atRoot: true, reason: "Unity memory snapshots — large, and not the project", recommended: true },
  { directory: "Recordings", atRoot: true, reason: "Unity recorder output", recommended: true },
  { directory: "UserSettings", atRoot: true, reason: "Your own editor layout — not part of the project", recommended: true },

  { directory: "DerivedDataCache", atRoot: true, reason: "Unreal's derived data cache — rebuilt on demand", recommended: true },
  { directory: "Intermediate", atRoot: true, reason: "Unreal build intermediates — rebuilt when you build", recommended: true },
  { directory: "Binaries", atRoot: true, reason: "Unreal compiled output — rebuilt when you build", recommended: true },
  /*
    Named like the work, and it is not: Unreal keeps logs, crash reports and
    autosaves here. Offered rather than ticked, because a folder called
    "Saved" is the one nobody should have excluded on our say-so.
  */
  { directory: "Saved", atRoot: true, reason: "Unreal logs and autosaves — check before excluding", recommended: false },

  { directory: ".godot", atRoot: true, reason: "Godot's import cache — rebuilt when the project next opens", recommended: true },
  { directory: ".import", atRoot: true, reason: "Godot's import cache — rebuilt when the project next opens", recommended: true },

  { directory: "Logs", atRoot: true, reason: "Editor logs", recommended: true },
  { directory: "obj", atRoot: true, reason: "Compiler intermediates — rebuilt when you build", recommended: true },
  { directory: ".vs", reason: "Visual Studio's local cache", recommended: true },
  /*
    Offered, not ticked. JetBrains keeps run configurations in here that some
    projects deliberately share, so this is a judgement rather than a fact.
  */
  { directory: ".idea", reason: "JetBrains editor state — check before excluding", recommended: false },

  /*
    A Chromium or Electron profile left in the project folder. Worth its own
    reason because the consequence is not only size: these hold lock files
    another program keeps open, and one unreadable file stops the whole save.
  */
  { directory: "IndexedDB", reason: "Browser profile data — holds files another program keeps open", recommended: true },
  { directory: "Local Storage", reason: "Browser profile data — holds files another program keeps open", recommended: true },
  { directory: "Session Storage", reason: "Browser profile data — holds files another program keeps open", recommended: true },
  { directory: "Service Worker", reason: "Browser profile data", recommended: true },
  { directory: "GPUCache", reason: "Browser cache", recommended: true },
  { directory: "Code Cache", reason: "Browser cache", recommended: true },
  { directory: "blob_storage", reason: "Browser profile data", recommended: true },

  /*
    Build output and archives are usually regenerable, but "dist" is also a
    perfectly ordinary folder name for hand-written files, so these are
    offered rather than recommended.
  */
  { directory: "dist", reason: "Usually build output — check before excluding", recommended: false },
  { directory: "build", reason: "Usually build output — check before excluding", recommended: false },
  { directory: "out", reason: "Usually build output — check before excluding", recommended: false },
  { directory: "bin", atRoot: true, reason: "Usually build output — check before excluding", recommended: false },

  { extension: ".safetensors", reason: "Model weights — large, and usually downloadable", recommended: false },
  { extension: ".ckpt", reason: "Model weights — large, and usually downloadable", recommended: false },
  { extension: ".pt", reason: "Model weights — large, and usually downloadable", recommended: false },
  { extension: ".pth", reason: "Model weights — large, and usually downloadable", recommended: false },
  { extension: ".cbx", reason: "A CodeBox bundle of this project, inside the project", recommended: true },
  { extension: ".pyc", reason: "Python bytecode", recommended: true },
  { extension: ".log", reason: "Log files", recommended: false },

  { file: "Local State", reason: "Browser profile data", recommended: true },
  { file: "Preferences", reason: "Browser profile data", recommended: true },
];

const norm = (value: string) => value.split("\\").join("/");

/**
 * What this folder appears to contain that is not the work.
 *
 * Ordered by size, because the decision somebody is making is about how long
 * their upload will take and the biggest item answers it. Anything matching
 * nothing is simply absent — silence is the right output for a tidy folder.
 */
/**
 * Which of github/gitignore's templates this folder is asking for.
 *
 * The templates have been vendored all along — three hundred of them, taken
 * from github/gitignore — but nothing ever chose one. A folder with no rules
 * of its own got the generic starter instead, and for a game project that is
 * the wrong list: it carries `build/`, `dist/`, `out/` and `models/**` from
 * the JavaScript and Python worlds, none of which are anchored, all of which
 * can reach into somewhere like `Assets/Art/models`.
 *
 * Recognised from the files a project must have to be that kind of project,
 * rather than from anything a person configures. Order matters: an engine is
 * decided first, because a Unity project also has a package.json somewhere
 * and the engine's own template is the one that knows about `Assets`.
 */
export function templatesFor(entries: string[]): string[] {
  const here = new Set(entries.map((name) => name.toLowerCase()));
  const any = (test: (name: string) => boolean) => entries.some(test);
  const picked: string[] = [];
  const take = (key: string) => {
    if (!picked.includes(key)) picked.push(key);
  };

  /* An engine first, and at most one: their templates overlap and disagree. */
  if (here.has("assets") && here.has("projectsettings")) take("unity");
  else if (any((name) => name.toLowerCase().endsWith(".uproject"))) {
    take("unrealengine");
  } else if (here.has("project.godot")) take("godot");
  /*
    Cocos before Node, and this order is the whole reason it is written down.

    A Cocos project carries a package.json, so recognising Node first called
    it a Node project and handed it Node's rules — which know nothing about
    `library` or `temp`, the caches Cocos rebuilds. Measured on the soak
    shape: eight and a half thousand cache files went from left out to sent.
  */
  else if (here.has("project.json") && here.has("assets")) take("cocos");

  /* Then the languages, of which a folder may honestly be several. */
  if (here.has("package.json")) take("node");
  if (
    here.has("pyproject.toml") ||
    here.has("requirements.txt") ||
    here.has("setup.py")
  ) {
    take("python");
  }
  if (here.has("cargo.toml")) take("rust");
  if (here.has("go.mod")) take("go");
  if (here.has("build.gradle") || here.has("build.gradle.kts")) take("gradle");
  /*
    An engine's own project files are not a second kind of project.

    Unity writes the .sln and the .csproj itself, and every engine here does
    something similar. Reading that as "also a Visual Studio project" and
    stacking GitHub's template on top is not a harmless extra: that template
    ignores `*.meta`, which in the .NET world is build output and in Unity is
    the sidecar carrying every asset's GUID. On a real project it would have
    dropped 13,689 of them, and a Unity project without its metas is exactly
    the broken-materials mess this was all started by.
  */
  const engine = picked.length > 0;
  if (!engine && any((name) => name.toLowerCase().endsWith(".sln"))) {
    take("visualstudio");
  }
  if (!engine && any((name) => name.toLowerCase().endsWith(".xcodeproj"))) {
    take("objective-c");
  }
  if (!engine && here.has("cmakelists.txt")) take("cmake");
  return picked;
}

export function suggestExclusions(files: ScannedFile[]): Suggestion[] {
  const totals = new Map<string, { bytes: number; files: number; rule: Rule }>();

  for (const entry of files) {
    const relative = norm(entry.path);
    const segments = relative.split("/");
    const name = segments[segments.length - 1] ?? "";
    const extension = path.extname(name).toLowerCase();

    for (const rule of RULES) {
      let pattern: string | null = null;
      if (rule.directory) {
        /*
          Matched without regard to case, and written back with the case the
          folder actually has.

          Every engine disagrees about capitals — Unity ships `Library` and
          `obj` in the same project, Unreal `Binaries`, Godot `.godot` — and
          an exact-name match meant the detector recognised whichever spelling
          happened to be written here and silently missed the rest. Emitting
          the observed name rather than the rule's own keeps the line that
          gets written matching the folder that is there.
        */
        const wanted = rule.directory.toLowerCase();
        /*
          At the root, where the rule is about the project's own output, and
          written anchored so it stays there. Unanchored, this offered to
          leave out `Assets/Props/obj` — a folder of 3D models — because a
          C# build also writes to a folder called obj. The file it proposed
          removing was the one the rules had just been fixed to protect.
        */
        const within = rule.atRoot ? segments.slice(0, 1) : segments.slice(0, -1);
        const found = within.find((segment) => segment.toLowerCase() === wanted);
        if (found) pattern = rule.atRoot ? `/${found}/` : `${found}/`;
      }
      if (!pattern && rule.file && name === rule.file) {
        pattern = rule.file;
      }
      if (!pattern && rule.extension && extension === rule.extension) {
        pattern = `*${rule.extension}`;
      }
      if (!pattern) continue;
      const held = totals.get(pattern) ?? { bytes: 0, files: 0, rule };
      held.bytes += entry.size;
      held.files += 1;
      totals.set(pattern, held);
      /*
        One rule per file. The list is ordered from most specific to least, so
        a .pyc inside __pycache__ is counted once, under the directory that
        explains it, rather than inflating two separate suggestions.
      */
      break;
    }
  }

  const named = [...totals.entries()].map(([pattern, held]) => ({
    pattern,
    reason: held.rule.reason,
    bytes: held.bytes,
    files: held.files,
    recommended: held.rule.recommended,
  }));

  /*
    Merged in here rather than offered through a second channel, so everything
    that shows a suggestion keeps working unchanged. A folder already named by
    a rule above is dropped: it has a better reason than "no source in it".

    Matched on the folder, not on how the line is written. The rules emit an
    anchored `/Library/` and this emits `Library/`, so comparing the patterns
    as text found no overlap and a Unity project was offered its own import
    cache twice over — once as "the editor rebuilds this" and once, below it,
    as "37,000 files and no source in it".
  */
  const asFolder = (pattern: string) =>
    pattern.replace(/^\/+|\/+$/g, "").toLowerCase();
  const already = new Set(named.map((one) => asFolder(one.pattern)));
  const bulk = suggestBulkDirectories(files).filter(
    (one) => !already.has(asFolder(one.pattern)),
  );

  return [...named, ...bulk].sort((left, right) => right.bytes - left.bytes);
}

/*
  Extensions that mean somebody wrote this by hand. Deliberately short: the
  question below is only "is there any source in here at all", and a longer
  list would answer yes for a folder holding one stray script.
*/
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php",
  ".lua", ".sh", ".ps1", ".sql", ".css", ".scss", ".html", ".vue", ".svelte",
  ".md", ".toml", ".yaml", ".yml", ".gradle", ".cmake",
]);

/** How many files a folder must hold before it is worth asking about. */
const BULK_FILES = 2_000;
/**
 * And how much of the upload it must be.
 *
 * Set high on purpose. At half, a game's 4,000-file `assets/` folder in a
 * 6,500-file project was flagged as "no source in it" — which is true and
 * beside the point, because the art is the work. The folders this is for are
 * not borderline: `work/` here is 98% of the upload and a Unity `Library/`
 * is 96%.
 */
const BULK_SHARE = 0.7;
/** Above this share of hand-written files it is source, not output. */
const BULK_SOURCE_SHARE = 0.1;

/**
 * And the same question asked in bytes, for a folder that is huge but not many.
 *
 * Counting files misses the shape that actually stops a save finishing. A real
 * project — 253 files — kept thirteen `.gguf` model weights in `output/`: 73
 * files, 10.67 GB, 99% of everything it would have sent and 29% of its file
 * count. Every threshold above is about counts, so nothing was suggested, and
 * the app set out to upload 10.7 GB of rebuildable model output without a word.
 * It never finished, and the project still has no version.
 *
 * A gigabyte is the floor because below it the upload is not the problem and
 * the question is not worth asking. The share is the same 0.7: a folder that is
 * most of the bytes, whatever its file count.
 */
const BULK_BYTES = 1024 * 1024 * 1024;

/*
  Media somebody made, as opposed to bytes a machine emitted.

  Needed only by the size test, and needed badly there. `SOURCE_EXTENSIONS`
  above asks "did a person type this", which is the right question for a folder
  judged on its file count — a cache holds no `.ts` files. It is the wrong
  question for a folder judged on its size, because a game's art holds no `.ts`
  files either, and by bytes the art is almost always most of the project. The
  count rule has a calibration case for exactly that folder; a size rule without
  this list would walk straight back into it and offer to leave the game out.
*/
const AUTHORED_EXTENSIONS = new Set([
  ".aseprite", ".blend", ".bmp", ".dds", ".exr", ".fbx", ".flac", ".gif",
  ".glb", ".gltf", ".hdr", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4",
  ".obj", ".ogg", ".otf", ".pdf", ".png", ".psd", ".svg", ".tga", ".tif",
  ".tiff", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2",
]);
/**
 * Above this share of a folder's *bytes* it is a library of made things.
 *
 * By bytes rather than by file count, because that is the currency the test it
 * guards is arguing in: one 4 GB video beside a thousand generated logs is a
 * folder of video, and counting files would call it a folder of logs.
 */
const AUTHORED_BYTE_SHARE = 0.5;

/**
 * One enormous folder that no list of names could have known about.
 *
 * Every rule above recognises a folder by its name, which works for the dozen
 * things every project has and not at all for the one a person invented. This
 * repository's own `work/` is 63,210 of the 64,554 files it would otherwise
 * send — scratch output from a test harness, named nothing in particular, and
 * invisible to every rule in this file. Another project's `output/` is 10.67 GB
 * of model weights in 73 files, which no count-based threshold can see at all.
 *
 * So this asks about shape instead of name, in both currencies: one folder that
 * is most of what would be sent — by file count or by size — and holds no
 * source in it. Never recommended, because the same shape is also what a
 * genuine dataset looks like, and a project whose work really is fifty thousand
 * data files should be asked once and then believed.
 */
export function suggestBulkDirectories(files: ScannedFile[]): Suggestion[] {
  const tally = new Map<
    string,
    { bytes: number; files: number; source: number; authored: number }
  >();
  let totalBytes = 0;
  for (const entry of files) {
    const normalised = entry.path.split("\\").join("/");
    totalBytes += entry.size;
    const top = normalised.includes("/") ? normalised.slice(0, normalised.indexOf("/")) : "";
    /* A file at the root belongs to no folder, so it cannot be one of these. */
    if (!top) continue;
    const held = tally.get(top) ?? { bytes: 0, files: 0, source: 0, authored: 0 };
    const extension = path.extname(normalised).toLowerCase();
    held.bytes += entry.size;
    held.files += 1;
    if (SOURCE_EXTENSIONS.has(extension)) held.source += 1;
    if (AUTHORED_EXTENSIONS.has(extension)) held.authored += entry.size;
    tally.set(top, held);
  }

  const found: Suggestion[] = [];
  for (const [top, held] of tally) {
    /*
      Whatever else is true of it, a folder with source in it is somebody's
      work. This is the one test both shapes below have to pass.
    */
    if (held.source / held.files >= BULK_SOURCE_SHARE) continue;

    const byCount =
      files.length >= BULK_FILES &&
      held.files >= BULK_FILES &&
      held.files / files.length >= BULK_SHARE;
    const byBytes =
      held.bytes >= BULK_BYTES &&
      held.bytes / Math.max(totalBytes, 1) >= BULK_SHARE &&
      /*
        And it is not a library of made things. A game's art is most of a game
        by size and is the last thing anybody wants left out of the save.
      */
      held.authored / Math.max(held.bytes, 1) < AUTHORED_BYTE_SHARE;
    if (!byCount && !byBytes) continue;

    /*
      Described in whichever currency makes the case. "73 of 253 files" is not
      an argument for leaving anything out; "10.7 GB of 10.8 GB" is the entire
      argument, and the person reading it is deciding whether to spend an
      evening uploading. Where both are true, size is still the thing that
      hurts, so size is what gets said.
    */
    const reason = byBytes
      ? `${formatBytes(held.bytes)} of ${formatBytes(totalBytes)}, ` +
        `and no source in it — generated?`
      : `${held.files.toLocaleString()} of ${files.length.toLocaleString()} files, ` +
        `and no source in it — generated?`;
    found.push({
      pattern: `${top}/`,
      reason,
      bytes: held.bytes,
      files: held.files,
      recommended: false,
    });
  }
  return found.sort((left, right) => right.bytes - left.bytes);
}

/**
 * The suggestions a person accepted, as lines for the rules file.
 *
 * Written as its own step so that nothing is ever applied as a side effect of
 * looking: the detector proposes, this records a decision, and the two are
 * only connected by somebody choosing.
 */
/**
 * The one heading under which accepted suggestions are recorded.
 *
 * Exported because three places wrote three different sentences for the same
 * idea, and a .gitignore could end up carrying all of them. The tick screen
 * keeps its own CHOSEN_HEADING: that block is a different statement, and it is
 * rewritten wholesale where this one is added to.
 */
export const SUGGESTED_HEADING = "# Suggested for this folder, and accepted.";

/** And the one under which the starter rules are brought up to date. */
export const STARTER_TOPUP_HEADING =
  "# Added when the starter rules were brought up to date.";

export function rulesFromSuggestions(accepted: Suggestion[]): string {
  if (!accepted.length) return "";
  return [SUGGESTED_HEADING, ...accepted.map((one) => one.pattern), ""].join(
    "\n",
  );
}
