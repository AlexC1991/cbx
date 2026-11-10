/**
 * The cbx-local 2 store (store_v2.ts): the same objects as v1, kept as solid
 * blocks and deltas. What matters is that nothing changes about what is
 * kept: every save comes back byte for byte, save ids are the ones v1 gives,
 * and damage is refused rather than handed back.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { init, restore, save } from "../dist/local/history.js";
import { Repository } from "../dist/local/repository.js";
import { ObjectStore } from "../dist/local/store.js";
import {
  encodeIndex,
  KIND_DELTA,
  KIND_SOLID,
  KIND_WHOLE,
  V2IndexFile,
} from "../dist/local/store_v2.js";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function folder(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-v2-"));
}

async function withFormat<T>(format: "1" | "2", work: () => Promise<T>): Promise<T> {
  const before = process.env.CBX_LOCAL_FORMAT;
  process.env.CBX_LOCAL_FORMAT = format;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.CBX_LOCAL_FORMAT;
    else process.env.CBX_LOCAL_FORMAT = before;
  }
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function walk(relative: string) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === ".cbx") continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else found.set(next, sha(await readFile(path.join(root, next))));
    }
  }
  await walk("");
  return found;
}

async function emptyFolder(root: string): Promise<void> {
  for (const entry of await readdir(root)) {
    if (entry !== ".cbx") await rm(path.join(root, entry), { recursive: true, force: true });
  }
}

function text(seed: number, lines: number): string {
  return Array.from({ length: lines }, (_, index) => `line ${seed}-${index} ${"abcdefgh".repeat(index % 9)}`).join("\n");
}

test("a v2 history brings every save back exactly, past the longest delta chain", async () => {
  const root = await folder();
  try {
    await withFormat("2", () => init(root));
    assert.equal((await readFile(path.join(root, ".cbx", "format"), "utf8")).trim(), "cbx-local 2");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), text(1, 400));
    await writeFile(path.join(root, "src", "b.ts"), text(2, 300));
    await writeFile(path.join(root, "big.bin"), Buffer.concat([randomBytes(300 * 1024), Buffer.from(text(3, 20000))]));
    const kept: Array<Map<string, string>> = [];
    const repository = await Repository.open(root);
    for (let round = 0; round < 16; round += 1) {
      if (round > 0) {
        const a = (await readFile(path.join(root, "src", "a.ts"), "utf8")).split("\n");
        a.splice(round * 7, 1, `edited in round ${round}`);
        await writeFile(path.join(root, "src", "a.ts"), a.join("\n"));
        if (round % 3 === 0) await writeFile(path.join(root, "src", `copy-${round}.ts`), `${text(2, 300)}\n// copy ${round}`);
        if (round === 5) await rm(path.join(root, "src", "b.ts"));
        const big = await readFile(path.join(root, "big.bin"));
        big.write(`round ${round}`, 200 * 1024 + round * 1000);
        await writeFile(path.join(root, "big.bin"), big);
      }
      const made = await save(repository, { message: `save ${round}` });
      assert.equal(made.saved, true);
      kept.push(await snapshot(root));
    }
    const chains: number[] = [];
    for (const name of (await readdir(path.join(root, ".cbx", "objects", "v2"))).filter((one) => one.endsWith(".idx"))) {
      const index = new V2IndexFile(name, await readFile(path.join(root, ".cbx", "objects", "v2", name)));
      for (const digest of index.names()) chains.push(index.find(digest)!.chain);
    }
    assert.ok(Math.max(...chains) >= 4, "edits were kept as deltas");
    assert.ok(Math.max(...chains) <= 12, "no delta stands on more than twelve others");
    for (let back = 15; back >= 0; back -= 1) {
      await emptyFolder(root);
      await restore(await Repository.open(root), { from: back ? `main~${back}` : "main", force: true });
      assert.deepEqual(await snapshot(root), kept[15 - back], `save ${15 - back} came back exactly`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v1 and v2 histories of the same folder name the same trees and saves", async () => {
  const roots = [await folder(), await folder()];
  try {
    const ids: string[][] = [];
    for (const [index, root] of roots.entries()) {
      await withFormat(index === 0 ? "1" : "2", () => init(root));
      await writeFile(path.join(root, "one.txt"), text(5, 200));
      await writeFile(path.join(root, "two.txt"), text(6, 100));
      const repository = await Repository.open(root);
      const now = new Date("2026-11-10T00:00:00Z");
      const first = await save(repository, { message: "first", author: "bench", now });
      await writeFile(path.join(root, "one.txt"), `${text(5, 200)}\nmore`);
      const second = await save(repository, { message: "second", author: "bench", now });
      assert.ok(first.saved && second.saved);
      ids.push([first.save.id, first.save.tree, second.save.id, second.save.tree]);
    }
    assert.deepEqual(ids[1], ids[0]);
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});

test("a damaged v2 pack is refused, never handed back wrong", async () => {
  const root = await folder();
  try {
    await withFormat("2", () => init(root));
    const original = text(7, 2000);
    await writeFile(path.join(root, "notes.txt"), original);
    const repository = await Repository.open(root);
    await save(repository, { message: "first" });
    const packs = path.join(root, ".cbx", "objects", "v2");
    const pack = path.join(packs, (await readdir(packs)).find((one) => one.endsWith(".pack"))!);
    const length = (await readFile(pack)).length;
    /* One flipped bit at many places, then a run of them: refused, or given back exactly. Never wrong. */
    for (const [at, run] of [[20, 1], [Math.floor(length / 3), 1], [Math.floor(length / 2), 1], [length - 12, 1], [Math.floor(length / 2), 64]]) {
      const handle = await open(pack, "r+");
      const bytes = Buffer.alloc(run!);
      await handle.read(bytes, 0, run!, at!);
      for (let index = 0; index < run!; index += 1) bytes[index] = bytes[index]! ^ 0x40;
      await handle.write(bytes, 0, run!, at!);
      await handle.close();
      await emptyFolder(root);
      const outcome = await restore(await Repository.open(root), { force: true }).then(
        () => "restored",
        (error: Error) => error.message,
      );
      if (outcome === "restored") {
        assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), original, `damage at ${at} handed back wrong bytes`);
      } else {
        assert.match(outcome, /damaged|could not be rebuilt/);
      }
      if (run! > 1) assert.notEqual(outcome, "restored", "a run of damaged bytes is refused");
      /* Put it back for the next place. */
      const again = await open(pack, "r+");
      await again.write(Buffer.from(bytes.map((byte) => byte ^ 0x40)), 0, run!, at!);
      await again.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the binary index finds every entry, with and without its fan-out", () => {
  for (const count of [3, 2000]) {
    const entries = new Map();
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = sha(`object ${index}`);
      names.push(name);
      entries.set(
        name,
        index % 5 === 0
          ? { kind: KIND_DELTA, chain: 3, offset: index * 10, length: 9, inner: 0, raw: 100 + index, base: names[0] }
          : { kind: index % 2 ? KIND_SOLID : KIND_WHOLE, chain: 0, offset: index * 10, length: 9, inner: index, raw: 100 + index },
      );
    }
    const index = new V2IndexFile("p", encodeIndex(entries));
    assert.equal(index.count, count);
    for (const name of names) {
      const found = index.find(name)!;
      const wanted = entries.get(name);
      assert.equal(found.kind, wanted.kind);
      assert.equal(found.offset, wanted.offset);
      assert.equal(found.raw, wanted.raw);
      assert.equal(found.base, wanted.base);
    }
    assert.equal(index.find(sha("not there")), undefined);
    assert.equal([...index.names()].length, count);
  }
});

test("large objects that compress are joined; ones that do not are kept as they are", async () => {
  const root = await folder();
  try {
    const store = new ObjectStore(root, { v2: true });
    const compressible = Buffer.from(text(9, 40000));
    const random = randomBytes(600 * 1024);
    const first = await store.put(compressible, { path: "a/log.txt" });
    const second = await store.put(random, { path: "a/noise.bin" });
    await store.flush();
    const reopened = new ObjectStore(root, { v2: true });
    assert.equal(sha(await reopened.get(first)), first);
    assert.equal(sha(await reopened.get(second)), second);
    const name = (await readdir(path.join(root, "v2"))).find((one) => one.endsWith(".idx"))!;
    const index = new V2IndexFile(name, await readFile(path.join(root, "v2", name)));
    assert.equal(index.find(first)!.kind, KIND_SOLID);
    assert.equal(index.find(second)!.kind, KIND_WHOLE);
    await reopened.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a v2 history keeps a compact index that reads back the same", async () => {
  const root = await folder();
  try {
    await withFormat("2", () => init(root));
    await writeFile(path.join(root, "a.txt"), "a");
    await writeFile(path.join(root, "empty.txt"), "");
    /* An index keeps only files whose times have settled; these are made old. */
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(root, "a.txt"), old, old);
    await utimes(path.join(root, "empty.txt"), old, old);
    const repository = await Repository.open(root);
    await save(repository, { message: "first" });
    const raw = JSON.parse(await readFile(path.join(root, ".cbx", "index.json"), "utf8"));
    assert.equal(raw.compact, 1);
    const index = await repository.readIndex();
    assert.deepEqual(index.get("a.txt")!.chunks, [sha("a")]);
    assert.deepEqual(index.get("empty.txt")!.chunks, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
