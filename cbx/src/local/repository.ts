/**
 * A local history: the `.cbx/` folder at the top of a project.
 *
 *   .cbx/format          "cbx-local 1", so a later layout can tell an older one
 *   .cbx/objects/        the object store (see store.ts)
 *   .cbx/lines/<name>    the id of the newest save on each line of work
 *   .cbx/state.json      which line the folder is on
 *   .cbx/config.json     the author name saves carry, and later the remotes
 *   .cbx/index.json      what each file looked like when it was last read
 *   .cbx/lock            present while something is writing
 *
 * A save is a JSON object naming a tree, its parents and who made it; its id
 * is the digest of those bytes. A tree lists every file with its size, digest,
 * whether it runs, and the objects its bytes are split into. Nothing in a save
 * or a tree depends on the machine it was made on, so two people who make the
 * same save from the same files get the same id.
 */
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DIGEST, ObjectStore } from "./store.js";

export const STORE_DIRECTORY = ".cbx";
export const FORMAT_LINE = "cbx-local 1";
export const DEFAULT_LINE = "main";

export type TreeEntry = {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  /** Object names, in order; one for a file under eight megabytes. */
  chunks: string[];
};

export type Tree = {
  format: "cbx-tree";
  version: 1;
  files: TreeEntry[];
};

export type SaveRecord = {
  format: "cbx-save";
  version: 1;
  tree: string;
  parents: string[];
  line: string;
  message: string;
  author: string;
  /** ISO 8601, UTC. */
  created: string;
};

export type Save = SaveRecord & { id: string };

type State = { line: string };
type Config = { author?: string };

/**
 * Line names are file names under `.cbx/lines`, so they are held to what is
 * safe as one on every platform: letters, digits, `.`, `_` and `-`, not
 * starting with a dot, and not something Windows reserves.
 */
export function lineNameProblem(name: string): string | null {
  if (!name) return "a line needs a name";
  if (name.length > 100) return "that name is longer than 100 characters";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return "use letters, digits, '.', '_' and '-', starting with a letter or digit";
  }
  if (name.endsWith(".") || name.includes("..")) return "that name has a stray dot";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) {
    return "Windows reserves that name";
  }
  if (name.endsWith(".partial")) return "names ending .partial are how cbx marks unfinished writes";
  return null;
}

async function writeAtomically(target: string, contents: string): Promise<void> {
  const partial = `${target}.partial`;
  await writeFile(partial, contents);
  await rename(partial, target);
}

async function exists(where: string): Promise<boolean> {
  try {
    await stat(where);
    return true;
  } catch {
    return false;
  }
}

export class Repository {
  readonly root: string;
  readonly directory: string;
  readonly objects: ObjectStore;

  private constructor(root: string) {
    this.root = root;
    this.directory = path.join(root, STORE_DIRECTORY);
    this.objects = new ObjectStore(path.join(this.directory, "objects"));
  }

  /** Start a history in `root`. Refuses a folder that already has one. */
  static async init(root: string, line = DEFAULT_LINE): Promise<Repository> {
    const problem = lineNameProblem(line);
    if (problem) throw new Error(`Cannot name a line "${line}": ${problem}.`);
    const full = path.resolve(root);
    const directory = path.join(full, STORE_DIRECTORY);
    if (await exists(directory)) {
      throw new Error(`${full} already has a history (${STORE_DIRECTORY}/).`);
    }
    await mkdir(path.join(directory, "objects"), { recursive: true });
    await mkdir(path.join(directory, "lines"), { recursive: true });
    await writeFile(path.join(directory, "format"), `${FORMAT_LINE}\n`);
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ line }));
    await writeFile(path.join(directory, "config.json"), "{}");
    return new Repository(full);
  }

  /** The history `from` is inside, looking upward; null when there is none. */
  static async find(from: string): Promise<Repository | null> {
    let at = path.resolve(from);
    for (;;) {
      const directory = path.join(at, STORE_DIRECTORY);
      if (await exists(path.join(directory, "format"))) {
        const format = (await readFile(path.join(directory, "format"), "utf8")).trim();
        if (format !== FORMAT_LINE) {
          throw new Error(
            `${directory} is in a format this cbx does not read (${format}). Update cbx.`,
          );
        }
        return new Repository(at);
      }
      const parent = path.dirname(at);
      if (parent === at) return null;
      at = parent;
    }
  }

  static async open(from: string): Promise<Repository> {
    const found = await Repository.find(from);
    if (!found) {
      throw new Error(
        `No history here. Run \`cbx init\` in the project folder to start one.`,
      );
    }
    return found;
  }

  /* ---- lines and state ------------------------------------------------ */

  async currentLine(): Promise<string> {
    const state = JSON.parse(
      await readFile(path.join(this.directory, "state.json"), "utf8"),
    ) as State;
    return state.line;
  }

  async setCurrentLine(line: string): Promise<void> {
    await writeAtomically(path.join(this.directory, "state.json"), JSON.stringify({ line }));
  }

  /** The newest save on `line`, or null for a line with nothing saved yet. */
  async lineTip(line: string): Promise<string | null> {
    if (lineNameProblem(line)) return null;
    try {
      const id = (await readFile(path.join(this.directory, "lines", line), "utf8")).trim();
      return DIGEST.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  async setLineTip(line: string, id: string): Promise<void> {
    const problem = lineNameProblem(line);
    if (problem) throw new Error(`Cannot name a line "${line}": ${problem}.`);
    await writeAtomically(path.join(this.directory, "lines", line), `${id}\n`);
  }

  async lineExists(line: string): Promise<boolean> {
    return !lineNameProblem(line) && (await exists(path.join(this.directory, "lines", line)));
  }

  async lines(): Promise<Array<{ name: string; tip: string }>> {
    const names = await readdir(path.join(this.directory, "lines")).catch(() => [] as string[]);
    const found: Array<{ name: string; tip: string }> = [];
    for (const name of names.sort()) {
      const tip = await this.lineTip(name);
      if (tip) found.push({ name, tip });
    }
    return found;
  }

  /** The save the folder was last saved or switched to, or null before the first. */
  async head(): Promise<string | null> {
    return this.lineTip(await this.currentLine());
  }

  /* ---- config --------------------------------------------------------- */

  async config(): Promise<Config> {
    try {
      return JSON.parse(await readFile(path.join(this.directory, "config.json"), "utf8"));
    } catch {
      return {};
    }
  }

  async setConfig(change: Partial<Config>): Promise<void> {
    const next = { ...(await this.config()), ...change };
    await writeAtomically(
      path.join(this.directory, "config.json"),
      JSON.stringify(next, null, 2),
    );
  }

  /**
   * Who a save says made it: the history's own setting, then CBX_AUTHOR,
   * then the account name on this machine. Only ever written into the save.
   */
  async author(): Promise<string> {
    const configured = (await this.config()).author?.trim();
    if (configured) return configured;
    const fromEnvironment = process.env.CBX_AUTHOR?.trim();
    if (fromEnvironment) return fromEnvironment;
    try {
      return os.userInfo().username || "unknown";
    } catch {
      return "unknown";
    }
  }

  /* ---- saves and trees ------------------------------------------------ */

  async readSave(id: string): Promise<Save> {
    const record = await this.objects.getJson<SaveRecord>(id);
    if (record.format !== "cbx-save") throw new Error(`${id.slice(0, 10)} is not a save.`);
    return { ...record, id };
  }

  async readTree(id: string): Promise<Tree> {
    const tree = await this.objects.getJson<Tree>(id);
    if (tree.format !== "cbx-tree") throw new Error(`${id.slice(0, 10)} is not a tree.`);
    return tree;
  }

  async writeSave(record: SaveRecord): Promise<Save> {
    /* Keys in a fixed order, so the same save is the same bytes everywhere. */
    const canonical: SaveRecord = {
      format: "cbx-save",
      version: 1,
      tree: record.tree,
      parents: record.parents,
      line: record.line,
      message: record.message,
      author: record.author,
      created: record.created,
    };
    const id = await this.objects.putJson(canonical);
    return { ...canonical, id };
  }

  async writeTree(files: TreeEntry[]): Promise<string> {
    const sorted = [...files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const tree: Tree = {
      format: "cbx-tree",
      version: 1,
      files: sorted.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        executable: file.executable,
        chunks: file.chunks,
      })),
    };
    return this.objects.putJson(tree);
  }

  /**
   * The save a name refers to.
   *
   * A line name, a line name followed by `~N` for N saves back along first
   * parents, or at least four characters of a save id. Ambiguous or unknown
   * names are refused with the reason.
   */
  async resolve(name: string): Promise<Save> {
    const back = /^(.*?)~(\d*)$/.exec(name);
    const base = back ? back[1]! : name;
    const steps = back ? Number(back[2] || "1") : 0;

    let id: string | null = null;
    if (base === "" || base === "HEAD") {
      id = await this.head();
      if (!id) throw new Error("Nothing has been saved on this line yet.");
    } else if (await this.lineExists(base)) {
      id = await this.lineTip(base);
    } else if (/^[0-9a-f]{4,64}$/.test(base)) {
      const candidates: string[] = [];
      for (const candidate of await this.objects.matching(base)) {
        try {
          await this.readSave(candidate);
          candidates.push(candidate);
        } catch {
          /* A tree or a piece of a file, not a save. */
        }
      }
      if (candidates.length > 1) {
        throw new Error(`"${base}" could be any of ${candidates.length} saves; give more of it.`);
      }
      id = candidates[0] ?? null;
    }
    if (!id) throw new Error(`No line or save called "${base}".`);

    let save = await this.readSave(id);
    for (let step = 0; step < steps; step += 1) {
      const parent = save.parents[0];
      if (!parent) throw new Error(`"${name}" goes back further than the line does.`);
      save = await this.readSave(parent);
    }
    return save;
  }

  /* ---- the index ------------------------------------------------------ */

  async readIndex(): Promise<Map<string, IndexEntry>> {
    try {
      const raw = JSON.parse(
        await readFile(path.join(this.directory, "index.json"), "utf8"),
      ) as Record<string, IndexEntry>;
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }

  async writeIndex(index: Map<string, IndexEntry>): Promise<void> {
    await writeAtomically(
      path.join(this.directory, "index.json"),
      JSON.stringify(Object.fromEntries(index)),
    );
  }

  /* ---- the lock ------------------------------------------------------- */

  /**
   * Run `work` while holding `.cbx/lock`.
   *
   * Two saves at once would each move the line to their own save and one
   * would be lost. A lock left behind by a crash is not cleared by guessing:
   * the message names the file so a person can remove it.
   */
  async locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = path.join(this.directory, "lock");
    let handle;
    try {
      handle = await open(lock, "wx");
    } catch {
      throw new Error(
        `Another cbx command is using this history. If none is running, delete ${lock} and try again.`,
      );
    }
    await handle.write(`${process.pid}\n`);
    await handle.close();
    try {
      return await work();
    } finally {
      await this.objects.release();
      await rm(lock, { force: true });
    }
  }
}

/** What a file looked like when its digest and pieces were last worked out. */
export type IndexEntry = {
  size: number;
  mtimeMs: number;
  sha256: string;
  chunks: string[];
};
