/** Output protection, shared by the API and both runners. Not an exfiltration sandbox. */
export function secretVariants(values: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const part of [value, ...value.split(/\r?\n/)]) {
      if (!part) continue;
      variants.add(part);
      variants.add(encodeURIComponent(part));
      variants.add(JSON.stringify(part).slice(1, -1));
    }
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

export function redactRunOutput(text: string, values: readonly string[] = []): string {
  // Strip terminal escapes before matching, so ANSI colour cannot split a value.
  let safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const value of secretVariants(values)) safe = safe.split(value).join("***");
  // Run tokens must be covered even after revocation, when only their hash remains.
  safe = safe.replace(/\b(?:cr(?:r|w|k|p|pj|pt)_[A-Za-z0-9_-]{16,256}|npm_[A-Za-z0-9]{20,256})\b/g, "***");
  safe = safe.replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"']+/gi, "$1***");
  safe = safe.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1***@");
  safe = safe.replace(/([?&](?:access_token|api_key|apikey|token|password|secret|signature|x-amz-signature)=)[^&#\s"']+/gi, "$1***");
  return safe;
}

/** Buffer complete lines: chunk boundaries must never turn a token into two public fragments. */
export class RunOutputStream {
  private pending = "";
  private omitting = false;
  constructor(private readonly values: readonly string[], private readonly limit = 64 * 1024) {}
  push(chunk: string): string {
    let safe = "";
    for (const part of chunk.split(/([\r\n])/)) {
      if (part === "\r" || part === "\n") {
        if (!this.omitting) safe += redactRunOutput(this.pending, this.values) + part;
        this.pending = "";
        this.omitting = false;
      } else if (!this.omitting) {
        if (this.pending.length + part.length > this.limit) {
          safe += "[Oversized output line omitted]\n";
          this.pending = "";
          this.omitting = true;
        } else this.pending += part;
      }
    }
    return safe;
  }
  end(): string {
    const safe = this.omitting ? "" : redactRunOutput(this.pending, this.values);
    this.pending = ""; this.omitting = false;
    return safe;
  }
}

/** Never export local authentication/configuration files, even under a broad glob. */
export function credentialArtifactPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").some(part =>
    /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|credentials(?:\.json)?|token(?:s)?\.json)$/i.test(part) ||
    /\.(?:pem|p12|pfx|key)$/i.test(part));
}

/** A best-effort raw-byte check; credential-bearing jobs must not export archives at all. */
export function artifactContainsSecret(bytes: Uint8Array, values: readonly string[]): boolean {
  const text = new TextDecoder().decode(bytes);
  return secretVariants(values).some(value => text.includes(value)) ||
    /\b(?:cr(?:r|w|k|p|pj|pt)_[A-Za-z0-9_-]{16,256}|npm_[A-Za-z0-9]{20,256})\b/.test(text);
}
