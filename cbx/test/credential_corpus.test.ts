/*
  How good the scanner actually is, as a number.

  "It detects any kind of secret" and "it never flags something that only
  looks like one" pull against each other, and no scanner gets both. Perfect
  recall means flagging anything with high entropy, which fires on commit
  hashes, lockfile digests and base64 images — and a check that fires on
  those is one people learn to click through, at which point it catches
  nothing at all.

  So the claim is measured rather than asserted. Two labelled sets: things
  that are credentials and must be caught, and things that merely look like
  credentials and must not be. The thresholds below fail the suite when a
  change to the patterns makes either side worse.

  Every credential here is invented. The shapes are real; the values match
  nothing and never did.
*/
import assert from "node:assert/strict";
import { test } from "node:test";

import { findCredentials } from "../dist/core/secret_patterns.js";

/** Random-looking filler, because sequential digits read as documentation. */
const fill = (n: number, alphabet = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ2345789") => {
  let out = "";
  /* Deterministic, so a failure is reproducible rather than occasional. */
  let seed = 0x2f6f2b79;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    /*
      The high bits, not the low ones.

      A linear congruential generator's low bits have a very short period, so
      `seed % 8` over a digit alphabet produced `2222222222222` — which the
      scanner then ignored, correctly, as somebody drawing a key rather than
      pasting one. That read as a missed format and was a bad sample. It is
      the second time filler has produced a false negative here; the first
      was sequential digits.
    */
    out += alphabet[(seed >>> 13) % alphabet.length];
  }
  return out;
};

/** Things that are credentials. Every one of these must be found. */
const CREDENTIALS: Array<[string, string]> = [
  ["anthropic", `ANTHROPIC_API_KEY = "sk-ant-${fill(40)}"`],
  ["openai", `OPENAI_API_KEY = "sk-${fill(44)}"`],
  ["openai project", `key = "sk-proj-${fill(40)}"`],
  ["aws", `AWS_ACCESS_KEY_ID = AKIA${fill(16, "ACDEFGHJKLMNPQRSTUVWXYZ2345789")}`],
  ["aws session", `id: ASIA${fill(16, "ACDEFGHJKLMNPQRSTUVWXYZ2345789")}`],
  ["github token", `token = "ghp_${fill(36)}"`],
  ["github pat", `GITHUB_PAT=github_pat_${fill(30)}`],
  ["gitlab", `GITLAB_TOKEN=glpat-${fill(24)}`],
  ["google", `apiKey: "AIza${fill(35)}"`],
  ["slack bot", `SLACK_BOT_TOKEN=xoxb-${fill(13, "23456789")}-${fill(13, "23456789")}-${fill(24)}`],
  ["stripe live", `STRIPE_SECRET = "sk_live_${fill(28)}"`],
  ["stripe restricted", `rk = "rk_live_${fill(28)}"`],
  ["sendgrid", `SENDGRID_API_KEY=SG.${fill(22)}.${fill(34)}`],
  ["npm", `//registry.npmjs.org/:_authToken=npm_${fill(36)}`],
  ["planetscale", `PSCALE = "pscale_tkn_${fill(36)}"`],
  ["huggingface", `HF_TOKEN=hf_${fill(36)}`],
  ["twilio", `TWILIO_ACCOUNT_SID=AC${fill(32, "abcdef23456789")}`],
  ["database url", `DATABASE_URL=postgres://svc:${fill(20)}@db.internal.acme.net:5432/prod`],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----\n" + fill(64) + "\n" + fill(64) + "\n-----END RSA PRIVATE KEY-----"],
  ["key in json", `{"stripe": "sk_live_${fill(28)}"}`],
  ["key in yaml", `stripe_key: sk_live_${fill(28)}`],
  ["key in an env line", `STRIPE=sk_live_${fill(28)}`],
];

/**
 * Things that look like credentials and are not.
 *
 * This is the half that decides whether anybody trusts the check. Each of
 * these appears in ordinary projects constantly.
 */
const LOOKALIKES: Array<[string, string]> = [
  ["a git commit sha", "const base = '9bb7986a2f448b9f786a7891c50fc5b8e95a3161';"],
  ["a short sha", "See commit 2f448b9 for the fix."],
  ["a uuid", 'id: "cdc24e1c-b4c1-44e2-b9af-46b5f47f4702"'],
  ["an npm integrity hash", '"integrity": "sha512-7mV3VnsGEtcbtL6rbEyTIKnGIcZ5VugFC8ab8QkynxadpmMd02Aw=="'],
  ["a subresource integrity tag", '<script integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC">'],
  ["a base64 image", 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"'],
  ["a docker digest", "image: nginx@sha256:2c0f1c4e8f6a9a1e1f0d7e6c5b4a39281706f5e4d3c2b1a0"],
  ["a jwt header only", 'const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";'],
  ["a public key", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDZ8vK1 user@host"],
  ["a bitcoin-looking address", 'const addr = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";'],
  ["a css hash class", ".index-B5vS6rZK { color: red; }"],
  ["minified javascript", "var a=function(b){return b.replace(/[A-Za-z0-9]{32,}/g,'')};"],
  ["a lockfile resolved url", '"resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"'],
  ["the aws documentation key", "AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLE"],
  ["a localhost connection string", "DATABASE_URL=postgres://user:password@localhost:5432/dev"],
  ["a built connection string", "const url = `postgres://${user}:${pass}@${host}/${name}`;"],
  ["a placeholder key", "OPENAI_API_KEY=sk-your-key-goes-here-0000000000000000"],
  ["a redacted key", 'token = "ghp_REDACTED_REDACTED_REDACTED_REDACT"'],
  /* Assembled, so no scanner mistakes this file for one holding a key. */
  ["a drawn key", `key = "${"sk_" + "live_" + "a".repeat(28)}"`],
  ["a terraform reference", 'password = var.database_password'],
  ["a kubernetes secret reference", "valueFrom:\n  secretKeyRef:\n    name: db\n    key: password"],
  ["an env var read", 'const key = process.env.STRIPE_SECRET_KEY;'],
  ["a long file path", "src/components/dashboard/settings/notifications/EmailPreferences.tsx"],
  ["a semver lockfile line", '"@coderook/cli": "0.25.4"'],
];

function measure() {
  const caught = CREDENTIALS.filter(([, text]) => findCredentials(text).length > 0);
  const missed = CREDENTIALS.filter(([, text]) => findCredentials(text).length === 0);
  const wrong = LOOKALIKES.filter(([, text]) => findCredentials(text).length > 0);
  const recall = caught.length / CREDENTIALS.length;
  const precision =
    caught.length / (caught.length + wrong.length || 1);
  return { missed, wrong, recall, precision };
}

test("it catches the credential formats it claims to", () => {
  const { missed, recall } = measure();
  /*
    A threshold rather than "all of them", so adding a format to the corpus
    that is not yet supported records the gap instead of blocking the suite.
  */
  assert.ok(
    recall >= 0.95,
    `recall ${(recall * 100).toFixed(0)}%, missed: ${missed.map(([name]) => name).join(", ")}`,
  );
});

test("it stays quiet about things that merely look like credentials", () => {
  const { wrong, precision } = measure();
  /*
    Held at 1.0 deliberately. A single false positive in this set is a real
    regression: every entry is something that appears in ordinary projects
    constantly, and one of them firing is how people learn to ignore the
    warning.
  */
  assert.equal(
    wrong.length,
    0,
    `flagged ${wrong.length} look-alikes: ${wrong.map(([name]) => name).join(", ")}`,
  );
  assert.equal(precision, 1);
});

test("the corpus is big enough for the numbers to mean anything", () => {
  assert.ok(CREDENTIALS.length >= 20, "too few credentials to measure recall");
  assert.ok(LOOKALIKES.length >= 20, "too few look-alikes to measure precision");
});

test("what the numbers are, so a change to them is visible in the log", () => {
  const { precision, recall, missed, wrong } = measure();
  console.log(
    `      corpus: recall ${(recall * 100).toFixed(1)}% ` +
      `(${CREDENTIALS.length - missed.length}/${CREDENTIALS.length}), ` +
      `precision ${(precision * 100).toFixed(1)}% ` +
      `(${wrong.length} false positives in ${LOOKALIKES.length})`,
  );
  assert.ok(true);
});
