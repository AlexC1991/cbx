/**
 * `push` and `pull` against a CodeRook that lives in memory.
 *
 * The stand-in keeps the service's rules that these commands lean on: a
 * version holds what its base held except the paths a save names, a save
 * whose base is not the line's head becomes a merge rather than a version,
 * and lines, versions and files are listed the way the real routes list
 * them. A real round trip against the service was run by hand as well; this
 * is what keeps the rules from drifting without one.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { init, log, save, UnsavedChanges } from "../dist/local/history.js";
import { pull, push, readRemote, RemoteAhead, RemoteDiffers } from "../dist/local/remote.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Version = {
  id: string;
  sequence: number;
  message: string;
  createdAt: string;
  author: string;
  parents: string[];
  files: Map<string, Buffer>;
};

class FakeCodeRook {
  repositories = new Map<string, { name: string; versions: Map<string, Version>; heads: Map<string, string | null> }>();
  executed = 0;
  /** Called before a publish lands; may throw or change what the service does. */
  beforeExecute: ((request: any) => void) | null = null;
  /** Extra files the service adds to the next version, as a merge would. */
  mergeIn: Map<string, Buffer> | null = null;

  repo(id: string) {
    const found = this.repositories.get(id);
    if (!found) throw new Error(`no repository ${id}`);
    return found;
  }

  tracks = {
    list: async (repositoryId: string) =>
      [...this.repo(repositoryId).heads].map(([name, head]) => ({
        id: name,
        name,
        kind: "line",
        headVersionId: head,
        protected: false,
      })),
    create: async (repositoryId: string, name: string, from?: string) => {
      this.repo(repositoryId).heads.set(name, from ?? null);
      return { id: name, name, kind: "line", headVersionId: from ?? null, protected: false };
    },
  };

  uploader = {
    plan: async (request: any) => ({ request }),
    execute: async (request: any) => {
      this.beforeExecute?.(request);
      this.executed += 1;
      let repositoryId = request.repositoryId as string | null;
      if (!repositoryId) {
        repositoryId = randomUUID();
        this.repositories.set(repositoryId, {
          name: request.projectName,
          versions: new Map(),
          heads: new Map([["main", null]]),
        });
      }
      const repository = this.repo(repositoryId);
      const line = request.track ?? "main";
      const head = repository.heads.get(line) ?? null;
      if ((request.baseVersionId ?? null) !== head) {
        return { repositoryId, versionId: "", sequence: 0, manifest: {}, mergeTrack: { id: "m", reference: "m1", conflicts: [] } };
      }
      const files = new Map(head ? repository.versions.get(head)!.files : []);
      for (const file of request.include as string[]) {
        if ((request.deletions ?? []).includes(file)) files.delete(file);
        else files.set(file, await readFile(path.join(request.localPath, file)));
      }
      for (const [file, bytes] of this.mergeIn ?? []) files.set(file, bytes);
      this.mergeIn = null;
      const version: Version = {
        id: randomUUID(),
        sequence: repository.versions.size + 1,
        message: request.message,
        createdAt: new Date(Date.UTC(2026, 8, 27, 0, repository.versions.size)).toISOString(),
        author: "Somebody",
        parents: head ? [head] : [],
        files,
      };
      repository.versions.set(version.id, version);
      repository.heads.set(line, version.id);
      const manifest = Object.fromEntries([...files].map(([file, bytes]) => [file, sha(bytes)]));
      return { repositoryId, versionId: version.id, sequence: version.sequence, manifest, local: manifest };
    },
  };

  downloader = {
    versions: async (repositoryId: string) =>
      [...this.repo(repositoryId).versions.values()]
        .sort((left, right) => right.sequence - left.sequence)
        .map((version) => ({
          id: version.id,
          sequence: version.sequence,
          message: version.message,
          fileCount: version.files.size,
          sourceSize: 0,
          createdAt: version.createdAt,
          authorName: version.author,
          parentVersionIds: version.parents,
        })),
    files: async (repositoryId: string, versionId: string) =>
      [...this.repo(repositoryId).versions.get(versionId)!.files].map(([file, bytes]) => ({
        path: file,
        sha256: sha(bytes),
        sourceSize: bytes.length,
        objectId: `object-${sha(bytes)}`,
      })),
    collect: async (
      repositoryId: string,
      versionId: string,
      files: Array<{ path: string }>,
      scratch: string,
      visit: (file: any, arrived: any) => Promise<void>,
    ) => {
      const held = this.repo(repositoryId).versions.get(versionId)!.files;
      await mkdir(scratch, { recursive: true });
      for (const file of files) {
        const bytes = held.get(file.path)!;
        /* Large files arrive on disk, as the real downloader hands them over. */
        if (bytes.length > 1024 * 1024) {
          const where = path.join(scratch, "arriving.partial");
          await writeFile(where, bytes);
          await visit(file, { path: where });
        } else {
          await visit(file, { bytes });
        }
      }
    },
  };

  get services() {
    return { tracks: this.tracks, uploader: this.uploader, downloader: this.downloader };
  }
}

const credentials = { apiUrl: "http://fake.invalid", token: async () => "t" } as any;

async function folder(files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-remote-"));
  for (const [name, contents] of Object.entries(files)) await put(root, name, contents);
  return root;
}

async function put(root: string, name: string, contents: string | Buffer): Promise<void> {
  const full = path.join(root, name);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  const past = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 10_000));
  await utimes(full, past, past);
}

/** Every file outside `.cbx`, by path, as bytes. */
async function contents(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (entry.name === ".cbx") continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found[path.relative(root, full).split(path.sep).join("/")] = sha(await readFile(full));
    }
  };
  await walk(root);
  return found;
}

test("saves pushed one by one arrive whole in a history pulled elsewhere", async () => {
  const server = new FakeCodeRook();
  const big = randomBytes(9 * 1024 * 1024);
  const here = await folder({ "src/game.txt": "speed = 1\n", "notes.txt": "tmp\n", "big.bin": big });
  const there = await folder();
  try {
    const repository = await init(here);
    await save(repository, { message: "First", author: "me" });
    await put(here, "src/game.txt", "speed = 2\n");
    await save(repository, { message: "Faster", author: "me" });
    await rm(path.join(here, "notes.txt"));
    await save(repository, { message: "Drop notes", author: "me" });

    const pushed = await push(repository, { credentials, projectName: "game", services: server.services });
    assert.equal(pushed.pushed.length, 3);
    assert.deepEqual(pushed.pushed.map((one) => one.sequence), [1, 2, 3]);
    const again = await push(repository, { credentials, projectName: "game", services: server.services });
    assert.equal(again.pushed.length, 0);
    assert.equal(server.executed, 3);

    const elsewhere = await init(there);
    const pulled = await pull(elsewhere, {
      credentials,
      repositoryId: pushed.repositoryId,
      services: server.services,
    });
    assert.equal(pulled.imported.length, 3);
    assert.equal(pulled.moved, true);
    assert.deepEqual(await contents(there), await contents(here));
    assert.deepEqual((await log(elsewhere)).map((one) => one.message), ["Drop notes", "Faster", "First"]);
    assert.equal((await log(elsewhere))[0]!.author, "Somebody");

    const nothing = await pull(elsewhere, { credentials, services: server.services });
    assert.equal(nothing.imported.length, 0);
    assert.equal(nothing.moved, false);
  } finally {
    await rm(here, { recursive: true, force: true });
    await rm(there, { recursive: true, force: true });
  }
});

test("a push onto a line CodeRook has moved sends nothing", async () => {
  const server = new FakeCodeRook();
  const one = await folder({ "a.txt": "a\n" });
  const two = await folder();
  try {
    const first = await init(one);
    await save(first, { message: "start", author: "me" });
    const { repositoryId } = await push(first, { credentials, projectName: "p", services: server.services });

    const second = await init(two);
    await pull(second, { credentials, repositoryId, services: server.services });
    await put(two, "b.txt", "b\n");
    await save(second, { message: "from two", author: "me" });
    await push(second, { credentials, projectName: "p", services: server.services });

    await put(one, "c.txt", "c\n");
    await save(first, { message: "from one", author: "me" });
    const before = server.executed;
    await assert.rejects(
      push(first, { credentials, projectName: "p", services: server.services }),
      RemoteAhead,
    );
    assert.equal(server.executed, before);

    /* Pulling fetches CodeRook's save and merges it with this line's own. */
    const pulled = await pull(first, { credentials, services: server.services });
    assert.ok(pulled.merged?.save);
    assert.equal(pulled.moved, true);
    assert.equal(await readFile(path.join(one, "c.txt"), "utf8"), "c\n");
    assert.equal(await readFile(path.join(one, "b.txt"), "utf8"), "b\n");

    /* The merge goes up as one save on top of CodeRook's head... */
    const sent = await push(first, { credentials, projectName: "p", services: server.services });
    assert.equal(sent.pushed.length, 1);
    assert.equal(sent.pushed[0]!.save.id, pulled.merged!.save!.id);

    /* ...and the other folder takes it as a plain move forward. */
    const caught = await pull(second, { credentials, services: server.services });
    assert.equal(caught.moved, true);
    assert.equal(caught.merged, undefined);
    assert.deepEqual(await contents(two), await contents(one));
  } finally {
    await rm(one, { recursive: true, force: true });
    await rm(two, { recursive: true, force: true });
  }
});

test("a pull stopped by an unsaved edit moves the folder once the edit is gone", async () => {
  const server = new FakeCodeRook();
  const one = await folder({ "a.txt": "a\n" });
  const two = await folder();
  try {
    const first = await init(one);
    await save(first, { message: "start", author: "me" });
    const { repositoryId } = await push(first, { credentials, projectName: "p", services: server.services });
    const second = await init(two);
    await pull(second, { credentials, repositoryId, services: server.services });

    await put(one, "a.txt", "changed on one\n");
    await save(first, { message: "change", author: "me" });
    await push(first, { credentials, projectName: "p", services: server.services });

    await put(two, "a.txt", "unsaved edit on two\n");
    await assert.rejects(pull(second, { credentials, services: server.services }), UnsavedChanges);
    assert.equal(await readFile(path.join(two, "a.txt"), "utf8"), "unsaved edit on two\n");

    /* Nothing new to import now, and it must still move. */
    await put(two, "a.txt", "a\n");
    const moved = await pull(second, { credentials, services: server.services });
    assert.equal(moved.imported.length, 0);
    assert.equal(moved.moved, true);
    assert.equal(await readFile(path.join(two, "a.txt"), "utf8"), "changed on one\n");
  } finally {
    await rm(one, { recursive: true, force: true });
    await rm(two, { recursive: true, force: true });
  }
});

test("a version that is not the save sent is never paired with it", async () => {
  const server = new FakeCodeRook();
  const here = await folder({ "a.txt": "a\n" });
  try {
    const repository = await init(here);
    await save(repository, { message: "start", author: "me" });
    server.mergeIn = new Map([["someone-else.txt", Buffer.from("theirs\n")]]);
    await assert.rejects(
      push(repository, { credentials, projectName: "p", services: server.services }),
      RemoteDiffers,
    );
    assert.deepEqual((await readRemote(repository)).pairs, {});
  } finally {
    await rm(here, { recursive: true, force: true });
  }
});

test("a push cut off part way resumes with the saves not yet sent", async () => {
  const server = new FakeCodeRook();
  const here = await folder({ "a.txt": "1\n" });
  try {
    const repository = await init(here);
    for (const step of ["2", "3", "4"]) {
      await save(repository, { message: `step ${step}`, author: "me" });
      await put(here, "a.txt", `${step}\n`);
    }
    await save(repository, { message: "last", author: "me" });
    let calls = 0;
    server.beforeExecute = () => {
      calls += 1;
      if (calls === 3) throw new Error("fetch failed");
    };
    await assert.rejects(
      push(repository, { credentials, projectName: "p", services: server.services }),
      /fetch failed/,
    );
    assert.equal(Object.keys((await readRemote(repository)).pairs).length, 2);
    server.beforeExecute = null;
    const resumed = await push(repository, { credentials, projectName: "p", services: server.services });
    assert.deepEqual(resumed.pushed.map((one) => one.sequence), [3, 4]);
    /* No stray scratch tree left in the history. */
    assert.ok(!(await readdir(path.join(here, ".cbx"))).includes("push"));
  } finally {
    await rm(here, { recursive: true, force: true });
  }
});

test("a pull that merges into a conflict is finished by saving, then pushes", async () => {
  const server = new FakeCodeRook();
  const one = await folder({ "a.txt": "speed = 1\n" });
  const two = await folder();
  try {
    const first = await init(one);
    await save(first, { message: "start", author: "me" });
    const { repositoryId } = await push(first, { credentials, projectName: "p", services: server.services });
    const second = await init(two);
    await pull(second, { credentials, repositoryId, services: server.services });

    await put(two, "a.txt", "speed = 2\n");
    await save(second, { message: "two", author: "me" });
    await push(second, { credentials, projectName: "p", services: server.services });

    await put(one, "a.txt", "speed = 3\n");
    await save(first, { message: "one", author: "me" });
    const pulled = await pull(first, { credentials, services: server.services });
    assert.deepEqual(pulled.merged?.conflicts?.map((one) => one.path), ["a.txt"]);
    await assert.rejects(
      push(first, { credentials, projectName: "p", services: server.services }),
      /merge is waiting/,
    );

    await put(one, "a.txt", "speed = 4\n");
    const finished = await save(first, { message: "", author: "me" });
    assert.ok(finished.saved);
    const sent = await push(first, { credentials, projectName: "p", services: server.services });
    assert.equal(sent.pushed.length, 1);
    await pull(second, { credentials, services: server.services });
    assert.equal(await readFile(path.join(two, "a.txt"), "utf8"), "speed = 4\n");
  } finally {
    await rm(one, { recursive: true, force: true });
    await rm(two, { recursive: true, force: true });
  }
});
