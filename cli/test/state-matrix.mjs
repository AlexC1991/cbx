/*
  The path-state matrix.

  For one path, four facts can disagree at once: the object in the folder's
  base version (B), the object this folder actually received (L), the bytes on
  disk now (D), and the object in the current head (H). The bug that reached
  production came from two of those being stored as one fact, so this walks
  the combinations that sit closest to it.

  Mira modifies and adds through a client, because that is the only way to
  create real objects. She deletes through the API, because the command line's
  add-and-update policy cannot express a deletion at all — and a remotely
  deleted path is half the matrix.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { assertSafeTarget, autoClean, scratchRoot, versionFilePayload } from "./live.mjs";
import { linkIn } from "./links.mjs";

assertSafeTarget();
/*
  Every row makes its own project, so the run needs one name of its own to
  sweep by — a bare "mx-" prefix would reach a concurrent run's work.
*/
const RUN = Math.random().toString(36).slice(2, 8);

const root = path.resolve(scratchRoot("suite-matrix"));
mkdirSync(root, { recursive: true });
const sweep = autoClean(
  (slug) => slug.startsWith("mx-") && slug.endsWith(`-${RUN}`),
  root,
);
const API = "https://api.coderook.com";
const token = readFileSync(
  path.join(process.env.APPDATA, "CodeRook", "token"), "utf8").trim();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const entry = path.resolve(import.meta.dirname, "../dist/cli/src/cli.js");

const api = async (route, method = "GET", body) => {
  const response = await fetch(`${API}${route}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

function rook(cwd, home, args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [entry, ...args], {
        cwd, encoding: "utf8",
        env: { ...process.env, CODEROOK_CONFIG_DIR: home, CODEROOK_TOKEN: token,
               NO_COLOR: "1" },
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const results = [];
function record(row, name, ok, detail = "") {
  results.push({ row, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${row}  ${name}`);
  if (!ok && detail) console.log(`          ${String(detail).replace(/\n/g, "\n          ")}`);
}

/** Republish the head without one path. No new objects, so no client needed. */
async function miraDeletes(repositoryId, drop) {
  const head = (await api(`/v1/repositories/${repositoryId}/versions`)).body.versions[0];
  const files = (
    await api(`/v1/repositories/${repositoryId}/versions/${head.id}/files`)
  ).body.files
    .filter((file) => file.path !== drop)
    .map(versionFilePayload);
  const created = await api(`/v1/repositories/${repositoryId}/versions`, "POST", {
    message: `mira deletes ${drop}`,
    expectedHeadVersionId: head.id,
    sourceSize: files.reduce((sum, file) => sum + file.sourceSize, 0),
    storedSize: files.reduce((sum, file) => sum + file.storedSize, 0),
    files,
  });
  if (created.status !== 201) {
    throw new Error(`mira could not delete: ${created.status} ${JSON.stringify(created.body)}`);
  }
}

/** What the head holds now, by name and content. */
function headHolds(homeM, slug) {
  const into = path.join(root, `mx-see-${Math.random().toString(36).slice(2, 8)}`);
  rook(root, homeM, ["clone", slug, into]);
  return Object.fromEntries(
    readdirSync(into).sort().map((name) => [
      name, readFileSync(path.join(into, name), "utf8").trim(),
    ]),
  );
}

/*
  Every row starts the same way: Sam publishes v1, so what he holds equals
  the base. Mira then moves the head, Sam's disk is set to the row's D, and
  Sam saves unrelated work twice without fetching — the shape that produced
  the production bug, which only appeared on the second save.
*/
async function row(label, setup) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const slug = `mx-${label.toLowerCase()}-${stamp}-${RUN}`;
  const sam = path.join(root, slug);
  const mira = path.join(root, `mx-mira-${stamp}`);
  const homeA = path.join(root, `mx-a-${stamp}`);
  const homeM = path.join(root, `mx-m-${stamp}`);
  for (const made of [sam, homeA, homeM]) mkdirSync(made, { recursive: true });

  const shared = path.join(sam, "shared.txt");
  writeFileSync(path.join(sam, "sam.txt"), "sam one\n");
  if (setup.base !== null) writeFileSync(shared, setup.base);
  rook(sam, homeA, ["submit", "-m", "v1"]);

  const repositoryId = linkIn(homeA, sam).repositoryId;

  try {
    await setup.mira({ repositoryId, mira, homeM, slug });

    if (setup.disk === null) rmSync(shared, { force: true });
    else writeFileSync(shared, setup.disk);
    writeFileSync(path.join(sam, "sam.txt"), "sam two\n");
    const saved = rook(sam, homeA, ["submit", "-m", "sam saves unrelated work"]);

    writeFileSync(path.join(sam, "sam.txt"), "sam three\n");
    const again = rook(sam, homeA, ["submit", "-m", "sam saves unrelated again"]);

    setup.expect({ holds: headHolds(homeM, slug), saved, again, label, homeA, sam });
  } catch (error) {
    record(label, "row ran to completion", false, error.message);
  } finally {
    await api(`/v1/repositories/${repositoryId}`, "DELETE");
  }
}

/** Mira clones and publishes whatever the row wants changed. */
const miraWrites = (contents) => ({ mira, homeM, slug }) => {
  rook(root, homeM, ["clone", slug, mira]);
  for (const [name, body] of Object.entries(contents)) {
    writeFileSync(path.join(mira, name), body);
  }
  const out = rook(mira, homeM, ["submit", "-m", "mira"]);
  if (!/Saved v/.test(out.out)) throw new Error(`mira could not publish:\n${out.out}`);
};

const openedMerge = (result) => /kept as (M-\d+)/.test(result.out);

// ── the matrix ──────────────────────────────────────────────────────────────

console.log("\nB = base version   L = what this folder received");
console.log("D = bytes on disk  H = current head\n");

// 1. Remote changed it; local user did nothing.
await row("R1  A A A B", {
  base: "A\n",
  mira: miraWrites({ "shared.txt": "B\n" }),
  disk: "A\n",
  expect: ({ holds, label }) =>
    record(label, "a stale copy does not revert the remote change",
      holds["shared.txt"] === "B", JSON.stringify(holds)),
});

// 2. Both changed it, on the same line.
await row("R2  A A C B", {
  base: "A\n",
  mira: miraWrites({ "shared.txt": "B\n" }),
  disk: "C\n",
  expect: ({ holds, saved, label }) => {
    record(label, "a real double edit becomes a decision, not a silent winner",
      openedMerge(saved), saved.out.trim().slice(0, 200));
    record(label, "and the head keeps the published side until it is decided",
      holds["shared.txt"] === "B", JSON.stringify(holds));
  },
});

// 3. Local deleted while remote modified.
await row("R3  A A - B", {
  base: "A\n",
  mira: miraWrites({ "shared.txt": "B\n" }),
  disk: null,
  expect: ({ holds, label }) =>
    record(label, "a local removal does not undo the remote change",
      holds["shared.txt"] === "B", JSON.stringify(holds)),
});

// 4. Remote added it; this folder never received it.
await row("R4  - - - B", {
  base: null,
  mira: miraWrites({ "shared.txt": "B\n" }),
  disk: null,
  expect: ({ holds, label }) =>
    record(label, "a file this folder never had survives its saves",
      holds["shared.txt"] === "B", JSON.stringify(holds)),
});

// 5. Both independently added the same path.
await row("R5  - - C B", {
  base: null,
  mira: miraWrites({ "shared.txt": "B\n" }),
  disk: "C\n",
  expect: ({ holds, saved, label }) => {
    record(label, "two independent additions become a decision",
      openedMerge(saved), saved.out.trim().slice(0, 200));
    record(label, "and the head keeps the published side",
      holds["shared.txt"] === "B", JSON.stringify(holds));
  },
});

// 6. Remote deleted it; the stale local copy must not put it back.
await row("R6  A A A -", {
  base: "A\n",
  mira: ({ repositoryId }) => miraDeletes(repositoryId, "shared.txt"),
  disk: "A\n",
  expect: ({ holds, label }) =>
    record(label, "a stale copy does not re-add a remotely deleted file",
      !("shared.txt" in holds), JSON.stringify(holds)),
});

// 7. Remote deleted it; the local user edited their copy.
await row("R7  A A C -", {
  base: "A\n",
  mira: ({ repositoryId }) => miraDeletes(repositoryId, "shared.txt"),
  disk: "C\n",
  expect: ({ holds, saved, label }) => {
    record(label, "it does not silently re-add the file", !("shared.txt" in holds),
      JSON.stringify(holds));
    record(label, "and the modify/delete is raised as a decision", openedMerge(saved),
      saved.out.trim().slice(0, 300));
  },
});

// 8. Both deleted it.
await row("R8  A A - -", {
  base: "A\n",
  mira: ({ repositoryId }) => miraDeletes(repositoryId, "shared.txt"),
  disk: null,
  expect: ({ holds, saved, label }) => {
    record(label, "agreeing on a deletion is not a conflict", !openedMerge(saved),
      saved.out.trim().slice(0, 200));
    record(label, "and it stays deleted", !("shared.txt" in holds), JSON.stringify(holds));
  },
});

await sweep();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log(`\nFailures:\n${failed.map((f) => `  ${f.row} — ${f.name}`).join("\n")}`);
}
process.exit(failed.length ? 1 : 0);
