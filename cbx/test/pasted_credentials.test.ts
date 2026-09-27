/**
 * Keys pasted into files that are not keys.
 *
 * The name check finds what a program wrote: `.env`, a cached login, an SSH
 * key. It is completely blind to the other kind of leak, where somebody
 * pastes a token into `settings.py` to get something working and never takes
 * it out — an ordinary name, an ordinary folder, and every check we had
 * waved it through.
 *
 * Two things have to hold for this check to be worth having. It must find
 * real keys, and it must stay quiet about the fake ones in documentation:
 * a warning that is usually wrong is one people learn to click past, which
 * costs more than not warning at all.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findCredentials,
  looksLikeText,
  maskAssignedValues,
  maskCredentials,
  worthReading,
} from "../dist/core/secret_patterns.js";
import { detectPastedCredentials } from "../dist/core/worktree.js";

/*
  Every value below is invented for this file, assembled to match a published
  format. None of them opens anything.
*/
const AWS = `AKIA${"Q7WZ4NB2XLKD9RTM"}`;
const GITHUB = `ghp_${"7Kq2mZ4xR8vB1nT6yH3pL0sW5dC9jF2gA4eU"}`;
const GOOGLE = `AIza${"SyC2mR8vK4pQ7wX1nZ6tB3hL9dJ0fY5gT2e"}`;
const STRIPE = `sk_live_${"51Hq8ZmR4vK2pT7wX1nB6cY3"}`;
const ANTHROPIC = `sk-ant-${"api03-7Kq2mZ4xR8vB1nT6yH3pL0sW5dC9jF2gA4eU"}`;

test("finds a key pasted into ordinary source", () => {
  const found = findCredentials(
    ["import boto3", "", `ACCESS = "${AWS}"`, "client = boto3.client('s3')"].join(
      "\n",
    ),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.name, "an AWS access key");
  // Line 3, as an editor counts, not 2 as an array does.
  assert.equal(found[0]?.line, 3);
});

test("never repeats the secret back", () => {
  /*
    A finding is shown in a window and may end up in a bug report, so it must
    carry enough to find the key in the file and not enough to use it.
  */
  const found = findCredentials(`token = "${GITHUB}"`);
  assert.equal(found.length, 1);
  assert.ok(!found[0]!.hint.includes(GITHUB));
  assert.ok(GITHUB.startsWith(found[0]!.hint.replace("…", "")));
  assert.ok(found[0]!.hint.length < 12);
});

test("names a key by the most specific format that fits", () => {
  // `sk-ant-…` is also a match for the general `sk-…` shape.
  const found = findCredentials(`KEY=${ANTHROPIC}`);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.name, "an Anthropic API key");
});

test("finds a database password in a connection string", () => {
  /*
    The one that is a sentence rather than a token, and does not look like a
    key at all — which is why nothing caught it before.
  */
  const found = findCredentials(
    "DATABASE_URL=postgresql://appuser:hunter2correct@db.internal.acme.net:5432/main",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.name, "a database password in a connection string");
});

test("finds several kinds in one file, in the order they appear", () => {
  const found = findCredentials(
    [`a = "${STRIPE}"`, "", `b = "${GOOGLE}"`, `c = "${GITHUB}"`].join("\n"),
  );
  assert.deepEqual(
    found.map((one) => one.line),
    [1, 3, 4],
  );
  assert.equal(found.length, 3);
});

test("stays quiet about the fake keys in documentation", () => {
  /*
    Every one of these appears in a real README somewhere. Flagging them puts
    a warning on every project that explains its own configuration, and that
    is how a warning stops being read.
  */
  const documentation = [
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    'GITHUB_TOKEN="ghp_your_token_here_xxxxxxxxxxxxxxxxxxxx"',
    "ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "DATABASE_URL=postgres://user:password@localhost:5432/example",
    "key = 'AIzaSyPLACEHOLDERPLACEHOLDERPLACEHOLDER'",
  ].join("\n");
  assert.deepEqual(findCredentials(documentation), []);
});

test("finds a private key embedded in a string, escaped newlines and all", () => {
  /*
    How a Google service-account file carries one, and the shape a key takes
    when somebody pastes it into JSON or JavaScript rather than a .pem. The
    newlines are two characters there, not one, which a check written for
    real PEM files misses entirely.
  */
  const material = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
  const found = findCredentials(
    `{"private_key": "-----BEGIN PRIVATE KEY-----\\n${material}\\n-----END PRIVATE KEY-----"}`,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.name, "a private key");
});

test("stays quiet about the PEM header every example prints", () => {
  /*
    Found while scanning a real project: a doc comment showing the shape of a
    certificate argument. The header is there, the key is not, and flagging
    it would warn about documentation in every library that handles keys.
  */
  const documentation = [
    ' *   privateKey: Redacted.make(',
    ' *     "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----",',
    ' *   ),',
  ].join("\n");
  assert.deepEqual(findCredentials(documentation), []);
});

test("stays quiet about a connection string the program builds", () => {
  /*
    Also from a real project. Code assembling a URL from variables is the
    correct way to do it and holds no secret — flagging it would put the
    warning on the right pattern and leave the wrong one unmarked.
  */
  const building = [
    "const url = `postgresql://${role.username}:${password}@${host}:5432/${db}`;",
    'uri = "mongodb+srv://%s:%s@cluster0.acme.net/test" % (user, pw)',
  ].join("\n");
  assert.deepEqual(findCredentials(building), []);
});

test("stays quiet about hashes and ids, which are not keys", () => {
  /*
    The reason the patterns are formats rather than "a long random string".
    A commit hash, a UUID and a base64 blob are in every project, and a check
    that flagged them would be wrong far more often than right.
  */
  const ordinary = [
    "commit 9f2a7c4e1b8d3056af71e2c9d40b6538ea1c7f92",
    "id: 3f7c1e2a-9b45-4d81-a6f0-2c8e5d1b7a34",
    "integrity: sha512-Kq2mZ4xR8vB1nT6yH3pL0sW5dC9jF2gA4eUq2mZ4xR8vB1nT6yH3pL0sW5dC9jF2gA==",
    "const colour = '#1b2a3c';",
  ].join("\n");
  assert.deepEqual(findCredentials(ordinary), []);
});

test("reads source and configuration, and skips what is compiled", () => {
  for (const name of ["settings.py", "config.yml", "app.ts", ".env", "Dockerfile"]) {
    assert.equal(worthReading(name), true, name);
  }
  for (const name of ["photo.jpg", "app.exe", "bundle.wasm", "video.mp4"]) {
    assert.equal(worthReading(name), false, name);
  }
});

test("knows text from something compiled by its bytes", () => {
  assert.equal(looksLikeText(new TextEncoder().encode("plain text")), true);
  assert.equal(looksLikeText(new Uint8Array([0x4d, 0x5a, 0x00, 0x01])), false);
});

test("scans only what is being sent", async () => {
  /*
    Narrowed to the selection, like every other check. A file the rules
    already leave behind is not being published, and raising it would train
    people to dismiss the question that matters.
  */
  const root = await mkdtemp(path.join(tmpdir(), "coderook-pasted-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "settings.py"), `KEY = "${AWS}"\n`);
    await writeFile(path.join(root, "left-behind.py"), `KEY = "${GITHUB}"\n`);
    await writeFile(path.join(root, "README.md"), "Set AWS_ACCESS_KEY_ID.\n");

    const { found, reach } = await detectPastedCredentials(root, [
      "src/settings.py",
      "README.md",
    ]);
    assert.deepEqual(
      found.map((one) => one.path),
      ["src/settings.py"],
    );
    assert.equal(found[0]?.found[0]?.name, "an AWS access key");
    /*
      And it says how far it got. The scan stops at twenty thousand files in
      silence, which on a forty-seven-thousand-file project left twenty-seven
      thousand never opened behind a clean-looking result.
    */
    assert.equal(reach.complete, true);
    assert.equal(reach.of, 2);
    assert.equal(reach.scanned, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
  Covering a credential where it is about to be shown.

  The upload warning never repeats a key back, and the diff pane behind it was
  printing one in full — so the same window both refused to show a credential
  and showed one. These cover the two shapes, which need different answers.
*/
test("a key pasted into source keeps its prefix and loses the rest", () => {
  const key = `sk_live_${"aB3dE5gH7jK9mN2pQ4rS6tU8".slice(0, 24)}`;
  const masked = maskCredentials(`STRIPE = "${key}"`);
  assert.ok(!masked.includes(key), "the value is gone");
  assert.match(masked, /sk_live/, "the prefix stays, so the line is findable");
  assert.match(masked, /\u2022/, "something marks where it was");
});

test("masking leaves everything around it alone", () => {
  const line = "const timeout = 30; // thirty seconds";
  assert.equal(maskCredentials(line), line);
});

test("masking and finding agree about documentation", () => {
  const doc = "AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLE";
  assert.equal(findCredentials(doc).length, 0);
  assert.equal(maskCredentials(doc), doc, "nothing flagged, so nothing covered");
});

test("in a credential file, a value of no known shape still goes", () => {
  /* What a .env holds: random, matching no service's format. */
  const line = "API_TOKEN=TkKN8rXVHKtacd9NMFsRMEuiU8JrwfYC";
  const masked = maskAssignedValues(line);
  assert.ok(!masked.includes("TkKN8rXVHKtacd9NMFsRMEuiU8JrwfYC"));
  assert.match(masked, /^API_TOKEN=/, "which setting it is stays readable");
});

test("an exported value and a quoted one are both covered", () => {
  for (const line of ['export SECRET="hunter2andthensome"', "PASSWORD: swordfishery"]) {
    const masked = maskAssignedValues(line);
    assert.ok(!/hunter2andthensome|swordfishery/.test(masked), line);
  }
});

test("a comment in a credential file is left readable", () => {
  const line = "# the token below is for staging only";
  assert.equal(maskAssignedValues(line), line);
});
