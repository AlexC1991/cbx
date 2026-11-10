import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The project's Settings, from the command line: the request each command
 * sends, checked through the real binary against a stand-in service.
 *
 * And the one setting that is not here: AI access is read only, refused
 * before anything is sent.
 */

const PROJECT = "7a1c9e44-2b3d-4f5a-8c6e-1d2f3a4b5c6d";
const HOOK = "3f2a9c10-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const DELIVERY = "7b1e04aa-1111-4222-8333-944455556666";
const SAM = "11111111-2222-4333-8444-555566667777";
const RULE = "99999999-8888-4777-8666-555544443333";
const BASE = `/v1/repositories/${PROJECT}`;

type Sent = { method: string; url: string; body: unknown };
type Handler = (body: unknown) => [number, unknown];

/** Answers the routes a test names, and the project lookup every command makes. */
async function service(routes: Record<string, Handler> = {}) {
  const sent: Sent[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const key = `${request.method} ${request.url}`;
    sent.push({ method: request.method ?? "", url: request.url ?? "", body });
    const reply = (status: number, value: unknown) => {
      if (status === 204) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (key === "GET /v1/repositories") {
      return reply(200, {
        repositories: [{ id: PROJECT, slug: "night-owl-diner", displayName: "Night Owl Diner", visibility: "public" }],
      });
    }
    const handler = routes[key];
    if (handler) {
      const [status, value] = handler(body);
      return reply(status, value);
    }
    return reply(404, { error: { message: `not here: ${key}` } });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as { port: number }).port;
  return {
    sent,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const home = mkdtempSync(path.join(tmpdir(), "coderook-settings-"));
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function run(origin: string, args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      [path.resolve("dist/cli/src/cli.js"), ...args],
      {
        cwd: home,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CODEROOK_API_URL: origin,
          CODEROOK_TOKEN: "test-token",
          CODEROOK_CONFIG_DIR: home,
          CODEROOK_PROJECT: "",
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) =>
        done({
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
          out: plain(String(stdout)),
          err: plain(String(stderr)),
        }),
    );
  });
}

/** What was sent, other than reads. */
const writes = (sent: Sent[]) =>
  sent.filter((one) => one.method !== "GET").map((one) => ({ method: one.method, url: one.url, body: one.body }));

/* ------------------------------------------------------------------- ai -- */

test("cbx ai refuses every old switch before asking the service anything", async () => {
  const api = await service();
  try {
    for (const flag of ["--read", "--download", "--contribute", "--request"]) {
      const result = await run(api.origin, ["ai", "night-owl-diner", flag, "off"]);
      assert.equal(result.code, 1, flag);
      assert.match(result.err, /cannot be changed from the command line/);
      assert.match(result.err, /Settings → Access & AI/);
      assert.match(result.err, /desktop app/);
    }
    assert.equal(api.sent.length, 0, JSON.stringify(api.sent));
  } finally {
    await api.close();
  }
});

test("cbx ai shows every answer, training as refused until the owner allows it, and sends no change", async () => {
  const api = await service({
    [`GET ${BASE}`]: () => [200, { id: PROJECT, ai: { read: false, download: true, contribute: true, request: false } }],
  });
  try {
    const result = await run(api.origin, ["ai", "night-owl-diner"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Can AI read this\?\s+refused/);
    /* Not sent by the service at all: unasked training is not permission to train. */
    assert.match(result.out, /Can AI train on this\?\s+refused/);
    assert.match(result.out, /Can AI download this\?\s+allowed/);
    assert.match(result.out, /Can AI make requests\?\s+refused/);
    assert.deepEqual(writes(api.sent), []);
  } finally {
    await api.close();
  }
});

test("cbx help ai offers no way to change it", async () => {
  const result = await run("http://127.0.0.1:9", ["help", "ai"]);
  assert.equal(result.code, 0);
  assert.ok(!/--read|--download|--contribute|--request/.test(result.out), result.out);
  assert.match(result.out, /never from the command line/);
});

/* ---------------------------------------------------------------- about -- */

test("cbx about changes the name and description in one PATCH", async () => {
  const api = await service({
    [`PATCH ${BASE}`]: (body) => [200, { id: PROJECT, ...(body as object) }],
    [`GET ${BASE}`]: () => [200, { id: PROJECT, slug: "night-owl-diner", displayName: "Diner", description: "After midnight.", ownerHandle: "alex" }],
  });
  try {
    const result = await run(api.origin, ["about", "night-owl-diner", "--name", "Diner", "--description", "After midnight."]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(writes(api.sent), [
      { method: "PATCH", url: BASE, body: { displayName: "Diner", description: "After midnight." } },
    ]);
    assert.match(result.out, /After midnight\./);
    assert.match(result.out, /alex\/night-owl-diner/);
  } finally {
    await api.close();
  }
});

test("cbx about refuses an empty name and sends nothing", async () => {
  const api = await service();
  try {
    const result = await run(api.origin, ["about", "night-owl-diner", "--name", ""]);
    assert.equal(result.code, 1);
    assert.deepEqual(writes(api.sent), []);
  } finally {
    await api.close();
  }
});

/* ----------------------------------------------------------- line-rules -- */

const LINES = {
  tracks: [
    { id: "t1", name: "main", kind: "line", protected: false, requiredApprovals: 0, requiredChecks: [], requireCodeOwner: false },
    { id: "t2", name: "merge-1", kind: "merge", protected: false, requiredApprovals: 0 },
  ],
};

test("cbx line-rules sends protection, approvals, and checks with code owners", async () => {
  const ok: Handler = () => [200, { saved: true }];
  const api = await service({
    [`GET ${BASE}/tracks`]: () => [200, LINES],
    [`PUT ${BASE}/tracks/main/protection`]: ok,
    [`PUT ${BASE}/tracks/main/review-policy`]: ok,
    [`PUT ${BASE}/tracks/main/rules`]: ok,
  });
  try {
    const result = await run(api.origin, [
      "line-rules", "main", "--protect", "--approvals", "2", "--checks", "build, test", "--code-owners", "on", "--project", "night-owl-diner",
    ]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(writes(api.sent), [
      { method: "PUT", url: `${BASE}/tracks/main/protection`, body: { protected: true } },
      { method: "PUT", url: `${BASE}/tracks/main/review-policy`, body: { requiredApprovals: 2 } },
      { method: "PUT", url: `${BASE}/tracks/main/rules`, body: { requiredChecks: ["build", "test"], requireCodeOwner: true } },
    ]);
  } finally {
    await api.close();
  }
});

test("cbx line-rules --checks none clears them; a missing line or bad count sends nothing", async () => {
  const api = await service({
    [`GET ${BASE}/tracks`]: () => [200, LINES],
    [`PUT ${BASE}/tracks/main/rules`]: () => [200, { saved: true }],
    [`GET ${BASE}/code-owners`]: () => [200, { rules: [{ pattern: "src/", owners: ["@alex"] }] }],
  });
  try {
    const cleared = await run(api.origin, ["line-rules", "main", "--unprotect", "--checks", "none", "--project", "night-owl-diner"]);
    /* The protection route is not answered here: its refusal stops the command. */
    assert.equal(cleared.code, 1);
    assert.match(cleared.err, /not here/);
    const only = await run(api.origin, ["line-rules", "main", "--checks", "none", "--project", "night-owl-diner"]);
    assert.equal(only.code, 0, only.err);
    const sentRules = writes(api.sent).filter((one) => one.url.endsWith("/rules"));
    assert.deepEqual(sentRules.at(-1)?.body, { requiredChecks: [] });

    const before = writes(api.sent).length;
    const missing = await run(api.origin, ["line-rules", "nope", "--protect", "--project", "night-owl-diner"]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /No line called "nope"/);
    const tooMany = await run(api.origin, ["line-rules", "main", "--approvals", "11", "--project", "night-owl-diner"]);
    assert.equal(tooMany.code, 1);
    const noLine = await run(api.origin, ["line-rules", "--protect", "--project", "night-owl-diner"]);
    assert.equal(noLine.code, 1);
    assert.equal(writes(api.sent).length, before);

    const listed = await run(api.origin, ["line-rules", "--project", "night-owl-diner"]);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /main/);
    assert.ok(!listed.out.includes("merge-1"), "merges are not lines");
    assert.match(listed.out, /src\/\s+@alex/);
  } finally {
    await api.close();
  }
});

/* --------------------------------------------------------- upload-rules -- */

test("cbx upload-rules sends the whole set, changing only what was named", async () => {
  const current = {
    ignoreRules: "node_modules/\n",
    keepRules: "!dist/release/\n",
    encryptSecretFiles: true,
    holdPushesForReview: true,
    warnLargeFileBytes: 1_073_741_824,
    updatedAt: null,
  };
  const api = await service({
    [`GET ${BASE}/rules`]: () => [200, current],
    [`PUT ${BASE}/rules`]: () => [200, { status: "ok" }],
  });
  const file = path.join(home, "ignore.txt");
  writeFileSync(file, "*.tmp\nbuild/\n");
  try {
    const result = await run(api.origin, [
      "upload-rules", "--project", "night-owl-diner", "--ignore", file, "--encrypt", "off", "--warn-large", "512",
    ]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(writes(api.sent), [
      {
        method: "PUT",
        url: `${BASE}/rules`,
        body: {
          ignoreRules: "*.tmp\nbuild/\n",
          keepRules: "!dist/release/\n",
          encryptSecretFiles: false,
          holdPushesForReview: true,
          warnLargeFileBytes: 512 * 1024 * 1024,
        },
      },
    ]);
    const missing = await run(api.origin, ["upload-rules", "--project", "night-owl-diner", "--keep", path.join(home, "absent.txt")]);
    assert.equal(missing.code, 1);
    assert.equal(writes(api.sent).length, 1);
  } finally {
    await api.close();
  }
});

/* ------------------------------------------------------------ assistant -- */

const ASSISTANT = {
  settings: { mode: "manual", review: true, describe: false, suggest: false, change: false, approve: false, merge: false, consentAt: null, consentBy: null },
  subscribed: true,
  available: true,
};

test("cbx assistant sends the mode and the switches named", async () => {
  const api = await service({
    [`GET ${BASE}/assistant`]: () => [200, ASSISTANT],
    [`PUT ${BASE}/assistant`]: (body) => [200, { settings: { ...ASSISTANT.settings, ...(body as object) } }],
  });
  try {
    const result = await run(api.origin, ["assistant", "automated", "--describe", "on", "--review", "off", "--project", "night-owl-diner"]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(writes(api.sent), [
      { method: "PUT", url: `${BASE}/assistant`, body: { mode: "automated", review: false, describe: true } },
    ]);
  } finally {
    await api.close();
  }
});

test("cbx assistant refuses merge without approve, and prints the subscription refusal plainly", async () => {
  const api = await service({
    [`GET ${BASE}/assistant`]: () => [200, ASSISTANT],
    [`PUT ${BASE}/assistant`]: () => [
      402,
      { error: { code: "assistant_needs_subscription", message: "The pull-request assistant comes with a subscription or a storage add-on on the repository owner's account." } },
    ],
  });
  try {
    const merge = await run(api.origin, ["assistant", "--merge", "on", "--project", "night-owl-diner"]);
    assert.equal(merge.code, 1);
    assert.match(merge.err, /Merging needs approving on too/);
    assert.deepEqual(writes(api.sent), []);

    const unpaid = await run(api.origin, ["assistant", "automated", "--project", "night-owl-diner"]);
    assert.equal(unpaid.code, 1);
    assert.match(unpaid.err, /comes with a subscription/);
    assert.ok(!/at .*\.js/.test(unpaid.err), "no stack trace");
  } finally {
    await api.close();
  }
});

/* ---------------------------------------------------------------- hooks -- */

const HOOKS = {
  webhooks: [{ id: HOOK, url: "https://example.com/hook", events: [], active: false, consecutive_failures: 20 }],
};
const DELIVERED = { id: DELIVERY, event: "ping", state: "delivered", attempts: 1, status: 200, detail: null, createdAt: "2026-10-24T00:00:00Z", deliveredAt: "2026-10-24T00:00:01Z" };

test("cbx hooks tests, lists, redelivers, changes events and switches back on", async () => {
  const api = await service({
    [`GET ${BASE}/webhooks`]: () => [200, HOOKS],
    [`POST ${BASE}/webhooks/${HOOK}/test`]: () => [200, { delivery: DELIVERED }],
    [`GET ${BASE}/webhooks/${HOOK}/deliveries`]: () => [200, { deliveries: [DELIVERED] }],
    [`POST ${BASE}/webhooks/${HOOK}/deliveries/${DELIVERY}/redeliver`]: () => [200, { delivery: DELIVERED }],
    [`PATCH ${BASE}/webhooks/${HOOK}`]: () => [200, { updated: true }],
  });
  try {
    const tested = await run(api.origin, ["hooks", "--test", "--project", "night-owl-diner"]);
    assert.equal(tested.code, 0, tested.err);
    assert.match(tested.out, /delivered \(200\)/);

    const listed = await run(api.origin, ["hooks", "--deliveries", HOOK, "--project", "night-owl-diner"]);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /7b1e04aa/);

    const again = await run(api.origin, ["hooks", "--redeliver", "7b1e04aa", "--project", "night-owl-diner"]);
    assert.equal(again.code, 0, again.err);

    const events = await run(api.origin, ["hooks", "--hook", "https://example.com/hook", "--events", "release.published,run.failed", "--project", "night-owl-diner"]);
    assert.equal(events.code, 0, events.err);
    const everything = await run(api.origin, ["hooks", "--hook", HOOK, "--events", "all", "--project", "night-owl-diner"]);
    assert.equal(everything.code, 0, everything.err);
    const on = await run(api.origin, ["hooks", "--on", HOOK, "--project", "night-owl-diner"]);
    assert.equal(on.code, 0, on.err);

    assert.deepEqual(writes(api.sent), [
      { method: "POST", url: `${BASE}/webhooks/${HOOK}/test`, body: null },
      { method: "POST", url: `${BASE}/webhooks/${HOOK}/deliveries/${DELIVERY}/redeliver`, body: null },
      { method: "PATCH", url: `${BASE}/webhooks/${HOOK}`, body: { events: ["release.published", "run.failed"] } },
      { method: "PATCH", url: `${BASE}/webhooks/${HOOK}`, body: { events: [] } },
      { method: "PATCH", url: `${BASE}/webhooks/${HOOK}`, body: { active: true } },
    ]);
  } finally {
    await api.close();
  }
});

/* ------------------------------------------------------ security policy -- */

test("cbx security policy turns reports on and sends the policy from a file", async () => {
  const api = await service({
    [`PUT ${BASE}/security-policy`]: () => [200, { saved: true }],
    [`GET ${BASE}/security-policy`]: () => [200, { enabled: true, policy: "Email security@example.com" }],
  });
  const file = path.join(home, "SECURITY.md");
  writeFileSync(file, "Email security@example.com\n");
  try {
    const result = await run(api.origin, ["security", "policy", "--on", "--text", file, "--project", "night-owl-diner"]);
    assert.equal(result.code, 0, result.err);
    const off = await run(api.origin, ["security", "policy", "--off", "--clear", "--project", "night-owl-diner"]);
    assert.equal(off.code, 0, off.err);
    assert.deepEqual(writes(api.sent), [
      { method: "PUT", url: `${BASE}/security-policy`, body: { enabled: true, policy: "Email security@example.com\n" } },
      { method: "PUT", url: `${BASE}/security-policy`, body: { enabled: false, policy: null } },
    ]);
  } finally {
    await api.close();
  }
});

/* --------------------------------------------------------------- people -- */

test("cbx people changes a role, removes somebody, and withdraws an invite", async () => {
  const api = await service({
    [`GET ${BASE}/collaborators`]: () => [
      200,
      {
        collaborators: [{ userId: SAM, displayName: "Sam", email: "sam@example.com", role: "write" }],
        invites: [{ id: "inv-1", email: "kit@example.com", role: "read", expiresAt: "2026-11-01T00:00:00Z" }],
      },
    ],
    [`PATCH ${BASE}/collaborators/${SAM}`]: () => [200, { status: "ok" }],
    [`DELETE ${BASE}/collaborators/${SAM}`]: () => [204, null],
    [`DELETE ${BASE}/invites/inv-1`]: () => [204, null],
  });
  try {
    const role = await run(api.origin, ["people", "night-owl-diner", "--change", "sam@example.com", "--role", "admin"]);
    assert.equal(role.code, 0, role.err);
    const removed = await run(api.origin, ["people", "night-owl-diner", "--remove", "Sam"]);
    assert.equal(removed.code, 0, removed.err);
    const withdrawn = await run(api.origin, ["people", "night-owl-diner", "--cancel-invite", "kit@example.com"]);
    assert.equal(withdrawn.code, 0, withdrawn.err);
    const noRole = await run(api.origin, ["people", "night-owl-diner", "--change", "sam@example.com", "--role", "owner"]);
    assert.equal(noRole.code, 1);
    const stranger = await run(api.origin, ["people", "night-owl-diner", "--remove", "nobody@example.com"]);
    assert.equal(stranger.code, 1);
    assert.deepEqual(writes(api.sent), [
      { method: "PATCH", url: `${BASE}/collaborators/${SAM}`, body: { role: "admin" } },
      { method: "DELETE", url: `${BASE}/collaborators/${SAM}`, body: null },
      { method: "DELETE", url: `${BASE}/invites/inv-1`, body: null },
    ]);
  } finally {
    await api.close();
  }
});

/* ------------------------------------------------------------ hand-over -- */

test("cbx hand-over needs a yes nobody can give from a pipe, and sends TRANSFER with --yes", async () => {
  const api = await service({
    [`POST ${BASE}/transfer`]: (body) => [
      200,
      { pending: true, transferId: "tr-1", expiresAt: "2026-11-07T00:00:00Z", keepAccess: (body as { keepAccess: boolean }).keepAccess, repositoryId: PROJECT, displayName: "Night Owl Diner", owner: "sam" },
    ],
    "GET /v1/account/transfers": () => [
      200,
      { incoming: [{ id: "tr-9", projectName: "Editor", slug: "editor", expiresAt: "2026-11-07T00:00:00Z", keepSenderAccess: true, fromUsername: "kit" }], outgoing: [] },
    ],
    "POST /v1/account/transfers/tr-9/accept": () => [200, { repositoryId: "r9", displayName: "Editor" }],
  });
  try {
    const asked = await run(api.origin, ["hand-over", "sam", "night-owl-diner"]);
    assert.equal(asked.code, 1);
    assert.match(asked.err, /needs TRANSFER typed/);
    assert.deepEqual(writes(api.sent), []);

    const sent = await run(api.origin, ["hand-over", "sam", "night-owl-diner", "--yes", "--drop-access"]);
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /offered to sam/);

    const accepted = await run(api.origin, ["hand-over", "accept", "editor"]);
    assert.equal(accepted.code, 0, accepted.err);

    assert.deepEqual(writes(api.sent), [
      { method: "POST", url: `${BASE}/transfer`, body: { recipient: "sam", confirmation: "TRANSFER", keepAccess: false } },
      { method: "POST", url: "/v1/account/transfers/tr-9/accept", body: null },
    ]);
  } finally {
    await api.close();
  }
});

/* --------------------------------------------------------------- issues -- */

test("cbx issue labels adds, changes and removes; rules are added and changed by number", async () => {
  const api = await service({
    [`GET ${BASE}/issue-labels`]: () => [200, { labels: [{ name: "bug", colour: "#d73a4a", description: null, open: 1 }] }],
    [`PUT ${BASE}/issue-labels/crash`]: () => [200, { saved: true }],
    [`PUT ${BASE}/issue-labels/bug`]: () => [200, { saved: true }],
    [`DELETE ${BASE}/issue-labels/bug`]: () => [204, null],
    [`GET ${BASE}/issue-rules`]: () => [200, { rules: [{ id: RULE, kind: "welcome", enabled: true, config: { message: "Hi" } }] }],
    [`POST ${BASE}/issue-rules`]: () => [201, { id: "new" }],
    [`PATCH ${BASE}/issue-rules/${RULE}`]: () => [200, { saved: true }],
    [`DELETE ${BASE}/issue-rules/${RULE}`]: () => [204, null],
  });
  const at = ["--project", "night-owl-diner"];
  try {
    for (const args of [
      ["issue", "labels", "add", "crash", "--colour", "e11d48", "--description", "It falls over"],
      ["issue", "labels", "change", "bug", "--name", "defect"],
      ["issue", "labels", "remove", "bug"],
      ["issue", "rules", "add", "auto-label", "--words", "crash, freeze", "--label", "crash"],
      ["issue", "rules", "off", "1"],
      ["issue", "rules", "change", "1", "-m", "Thanks!"],
      ["issue", "rules", "remove", "1"],
    ]) {
      const result = await run(api.origin, [...args, ...at]);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.err}`);
    }
    const duplicate = await run(api.origin, ["issue", "labels", "add", "bug", ...at]);
    assert.equal(duplicate.code, 1);
    const unknown = await run(api.origin, ["issue", "labels", "change", "nope", "--colour", "000000", ...at]);
    assert.equal(unknown.code, 1);
    assert.deepEqual(writes(api.sent), [
      { method: "PUT", url: `${BASE}/issue-labels/crash`, body: { colour: "#e11d48", description: "It falls over" } },
      { method: "PUT", url: `${BASE}/issue-labels/bug`, body: { name: "defect" } },
      { method: "DELETE", url: `${BASE}/issue-labels/bug`, body: null },
      { method: "POST", url: `${BASE}/issue-rules`, body: { kind: "auto_label", config: { words: ["crash", "freeze"], label: "crash" } } },
      { method: "PATCH", url: `${BASE}/issue-rules/${RULE}`, body: { enabled: false } },
      { method: "PATCH", url: `${BASE}/issue-rules/${RULE}`, body: { config: { message: "Thanks!" } } },
      { method: "DELETE", url: `${BASE}/issue-rules/${RULE}`, body: null },
    ]);
  } finally {
    await api.close();
  }
});
