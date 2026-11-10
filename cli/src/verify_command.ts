/**
 * `cbx verify` — check a downloaded file against its release's signed manifest.
 * `cbx deps`   — known vulnerabilities in a save's dependencies.
 *
 * verify fetches the release's manifest (every file with its size and SHA-256,
 * signed with CodeRook's Ed25519 release key), checks the signature, then
 * hashes the local file and compares. The key is the one this copy of cbx was
 * built with when it has one, otherwise the one the service publishes, and
 * --key pins another.
 */
import { createHash, webcrypto } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { callApi, versions } from "./api.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { apiOrigin, DEFAULT_API } from "./config.js";
import { resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";

/** CodeRook's release key as published when this version of cbx was built; empty means ask the service. */
export const PINNED_RELEASE_KEY = "H8/DZlJXqNjUBOT7OXIoR4aEM+gcfhxurfdCrk83wNA=";

type Manifest = {
  format: string;
  project: string;
  release: string;
  version: number;
  channel: string;
  prerelease: boolean;
  publishedAt: string;
  files: Array<{ name: string; size: number; sha256: string }>;
};

/** The exact bytes the service signs: the same key order, files by name. */
export function manifestBytes(manifest: Manifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      format: manifest.format,
      project: manifest.project,
      release: manifest.release,
      version: manifest.version,
      channel: manifest.channel,
      prerelease: manifest.prerelease,
      publishedAt: manifest.publishedAt,
      files: [...manifest.files]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((file) => ({ name: file.name, size: file.size, sha256: file.sha256 })),
    }),
  );
}

export async function signatureValid(publicKey: string, manifest: Manifest, signature: string): Promise<boolean> {
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(publicKey, "base64"), { name: "Ed25519" }, false, ["verify"]);
  return webcrypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(signature, "base64"), manifestBytes(manifest));
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

export async function commandVerify(parsed: Parsed): Promise<number> {
  const [project, release, ...files] = parsed.positional;
  if (!project || !project.includes("/") || !release || !files.length) {
    console.error(red("Try: cbx verify owner/project v1.0 ./app-setup.exe"));
    return 1;
  }
  const [owner, slug] = project.split("/") as [string, string];
  const base = `${apiOrigin()}/v1/public/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/releases/${encodeURIComponent(release)}`;
  const response = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    console.error(red(`No signed manifest for ${project} ${release} (${response.status}).`));
    return 1;
  }
  const answer = (await response.json()) as { manifest: Manifest; signature: string; publicKey: string };
  const pinned = parsed.flags.get("key");
  const key =
    typeof pinned === "string" ? pinned : PINNED_RELEASE_KEY && apiOrigin() === DEFAULT_API ? PINNED_RELEASE_KEY : answer.publicKey;
  if (!(await signatureValid(key, answer.manifest, answer.signature))) {
    console.error(red("The manifest's signature does not check out. Do not trust these files."));
    return 1;
  }
  console.log(`${green("✓")} Signed manifest for ${bold(`${answer.manifest.project} ${answer.manifest.release}`)} ${dim(`(key ${key.slice(0, 12)}…)`)}`);
  let failed = false;
  for (const file of files) {
    const name = path.basename(file);
    const entry = answer.manifest.files.find((one) => one.name === name);
    if (!entry) {
      console.log(`${red("×")} ${name}: not one of this release's files`);
      failed = true;
      continue;
    }
    const size = (await stat(file)).size;
    const digest = await sha256File(file);
    if (size !== entry.size || digest !== entry.sha256) {
      console.log(`${red("×")} ${name}: does not match (${size} bytes, ${digest.slice(0, 16)}…; expected ${entry.size} bytes, ${entry.sha256.slice(0, 16)}…)`);
      failed = true;
    } else {
      console.log(`${green("✓")} ${name} ${dim(`${digest.slice(0, 16)}…`)}`);
    }
  }
  return failed ? 1 : 0;
}

type Report = {
  state: string;
  packages: number;
  findings: Array<{ ecosystem: string; name: string; version: string; file: string; ids: string[]; summary: string | null }>;
  error: string | null;
};

export async function commandDeps(parsed: Parsed): Promise<number> {
  const named = parsed.flags.get("project");
  const project = await resolveProject(typeof named === "string" ? named : undefined);
  if (!project) return 1;
  const all = await versions(project.id);
  const asked = parsed.positional[0];
  const target = asked
    ? all.find((one) => String(one.sequence) === asked.replace(/^v/i, ""))
    : all.reduce<(typeof all)[number] | undefined>((newest, one) => (!newest || one.sequence > newest.sequence ? one : newest), undefined);
  if (!target) {
    console.error(red(asked ? `${project.name} has no version ${asked}.` : "This project has no saves yet."));
    return 1;
  }
  const report = await callApi<Report>(
    `/v1/repositories/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(target.id)}/dependencies${parsed.flags.has("fresh") ? "?fresh=1" : ""}`,
  );
  if (report.state === "none") {
    console.log(dim(`v${target.sequence} has no lockfile to check.`));
    return 0;
  }
  if (report.state === "failed") {
    console.error(red(`Could not ask OSV: ${report.error ?? "unknown"}`));
    return 1;
  }
  if (!report.findings.length) {
    console.log(`${green("✓")} v${target.sequence}: ${report.packages} packages, no known vulnerabilities.`);
    return 0;
  }
  console.log(red(`v${target.sequence}: ${report.findings.length} of ${report.packages} packages have known vulnerabilities`));
  for (const finding of report.findings) {
    console.log(`  ${accent(`${finding.name}@${finding.version}`)} ${dim(`${finding.ecosystem} · ${finding.file}`)}`);
    console.log(`    ${finding.ids.slice(0, 4).join(", ")}${finding.summary ? dim(` — ${finding.summary}`) : ""}`);
  }
  return 1;
}
