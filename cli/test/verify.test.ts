import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

const { manifestBytes, signatureValid } = await import("../dist/cli/src/verify_command.js");
const { maskSecrets } = await import("../dist/cli/src/runner.js");

const manifest = {
  format: "coderook-release-manifest/1",
  project: "sam/editor",
  release: "v2.0.0",
  version: 41,
  channel: "stable",
  prerelease: false,
  publishedAt: "2026-10-19T00:00:00.000Z",
  files: [
    { name: "setup.exe", size: 10, sha256: "ab".repeat(32) },
    { name: "app.zip", size: 5, sha256: "cd".repeat(32) },
  ],
};

test("a manifest signed by the release key checks out, and a changed one does not", async () => {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, manifestBytes(manifest))).toString("base64");
  assert.equal(await signatureValid(raw, manifest, signature), true);
  /* The order files are listed in is not part of what is signed. */
  assert.equal(await signatureValid(raw, { ...manifest, files: [...manifest.files].reverse() }, signature), true);
  assert.equal(await signatureValid(raw, { ...manifest, release: "v2.0.1" }, signature), false);
});

test("the bytes signed list files by name with the keys in a fixed order", () => {
  const text = new TextDecoder().decode(manifestBytes(manifest));
  assert.ok(text.startsWith('{"format":"coderook-release-manifest/1","project":"sam/editor"'));
  assert.ok(text.indexOf('"app.zip"') < text.indexOf('"setup.exe"'));
});

test("a run's output has its secrets replaced before it is shown or sent", () => {
  assert.equal(maskSecrets("deploying with s3cr3t-token now", ["s3cr3t-token"]), "deploying with *** now");
  assert.equal(maskSecrets("ab cd", ["ab"]), "*** cd");
});
