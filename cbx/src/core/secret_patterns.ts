/**
 * Credentials recognised by what they are, not by what they are called.
 *
 * The existing check reads names: `.env`, `id_ed25519`, anything ending
 * `.pem`. That catches the files a tool writes without being asked, which is
 * where most accidental leaks come from — and it is completely blind to the
 * other kind, where somebody pastes a key into `config.py` while getting
 * something working and never takes it out. That file has an ordinary name,
 * sits in an ordinary folder, and every check we had waved it through.
 *
 * So these patterns match the keys themselves. Each one is a format some
 * service publishes and no ordinary text produces: a fixed prefix and a fixed
 * length, not "a long random-looking string", which would flag every hash and
 * teach people to ignore the warning. A check that cries wolf is worse than
 * no check, because it trains the answer.
 *
 * Nothing here ever returns the secret. A finding is a file, a line, and what
 * kind of key it is — enough to go and look, and safe to put in a log, a
 * window, or a bug report.
 */

/** One credential format, and what to call it in front of a person. */
export type CredentialPattern = {
  id: string;
  /** What it is, in words somebody can act on. */
  name: string;
  match: RegExp;
};

/*
  Ordered most specific first. `sk-ant-…` is also a match for the more general
  `sk-…`, and whichever runs first should be the one that gets to name it —
  the scan below drops later matches that overlap an earlier one, so this
  order is what decides that "an Anthropic API key" beats "an OpenAI API key".
*/
export const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  {
    id: "private-key",
    name: "a private key",
    /*
      The header alone is not a key. Documentation writes it constantly —
      `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----` is how
      every example shows the shape — so the match requires real key material
      after it. Escaped newlines count as newlines, because a key embedded in
      JSON or a JavaScript string is exactly how a service-account file
      carries one, and that is the case worth catching.
    */
    match:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----(?:\s|\\[rn])*[A-Za-z0-9+/=]{40,}/g,
  },
  {
    id: "anthropic",
    name: "an Anthropic API key",
    match: /\bsk-ant-[A-Za-z0-9_-]{24,}/g,
  },
  {
    id: "openai",
    name: "an OpenAI API key",
    match: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g,
  },
  {
    id: "aws-access-key",
    name: "an AWS access key",
    match: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "azure-storage-key",
    name: "an Azure storage key",
    match: /AccountKey=[A-Za-z0-9+/]{80,}={0,2}/g,
  },
  {
    id: "github-token",
    name: "a GitHub token",
    match: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "github-pat",
    name: "a GitHub fine-grained token",
    match: /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  },
  {
    id: "gitlab-token",
    name: "a GitLab token",
    match: /\bglpat-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "google-api-key",
    name: "a Google API key",
    match: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "slack-token",
    name: "a Slack token",
    match: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
  },
  {
    id: "stripe-live-key",
    name: "a live Stripe key",
    match: /\b[sr]k_live_[0-9A-Za-z]{20,}/g,
  },
  {
    id: "sendgrid",
    name: "a SendGrid key",
    match: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}/g,
  },
  {
    id: "npm-token",
    name: "an npm token",
    match: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "planetscale",
    name: "a PlanetScale credential",
    match: /\bpscale_(?:tkn|pw|oauth)_[A-Za-z0-9_-]{32,}/g,
  },
  {
    id: "huggingface",
    name: "a Hugging Face token",
    match: /\bhf_[A-Za-z0-9]{34,}/g,
  },
  {
    id: "discord-bot-token",
    name: "a Discord bot token",
    match: /\b[MNO][A-Za-z0-9_-]{23,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
  },
  {
    id: "twilio-sid",
    name: "a Twilio account SID",
    match: /\bAC[0-9a-f]{32}\b/g,
  },
  {
    /*
      The one that is a sentence rather than a token. A database URL with the
      password still in it is how a whole database gets handed over, and it
      does not look like a key at all — which is exactly why nothing caught
      it before.
    */
    id: "database-url",
    name: "a database password in a connection string",
    /*
      The host is part of the match on purpose. Documentation is full of
      these, and what distinguishes a real one is not the password — which is
      often literally the word "password" in both — but where it points.
      Matching through the host lets the placeholder check see `localhost`
      and `example.com` and stay quiet.
    */
    match:
      /\b(?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/?#"']+/g,
  },
];

/*
  Words that mean "this is the shape, not the secret".

  Documentation is full of keys, and every one of them is fake. Flagging those
  would put a warning on the README of every project that explains its own
  configuration — and a warning that is usually wrong is a warning people
  learn to click past, including the time it is right.
*/
const PLACEHOLDER = [
  "example",
  "placeholder",
  "your-",
  "your_",
  "yourkey",
  "youraccount",
  "changeme",
  "change-me",
  "redacted",
  "dummy",
  "sample",
  "insert",
  "replace",
  "notreal",
  "fake",
  "test-key",
  /*
    Where a connection string points, when it points nowhere real. A database
    URL aimed at the machine it is written on is somebody's own setup, not a
    credential anybody else can use.
  */
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "host:port",
  ":password@",
  ":pass@",
  ":secret@",
  "xxxx",
  "0000",
  "1234567890",
  "abcdef123456",
];

/** Whether this looks like documentation rather than a live credential. */
export function looksLikePlaceholder(value: string): boolean {
  const flat = value.toLowerCase();
  if (PLACEHOLDER.some((word) => flat.includes(word))) return true;
  /*
    A value the program builds at run time is not a value in the file. Code
    that assembles a connection string from variables —
    `postgresql://${user}:${password}@${host}` — is the ordinary way to do it
    and holds no secret at all, so flagging it would put a warning on the
    correct pattern and none on the wrong one.
  */
  if (/\$\{|\{\{|%\(|%s|\$\(|<[A-Za-z_][A-Za-z0-9_ -]*>/.test(value)) {
    return true;
  }
  /*
    A run of one repeated character is somebody drawing a key rather than
    pasting one. Real keys do not contain `aaaaaaaaaa`.
  */
  if (/(.)\1{7,}/.test(value)) return true;
  return false;
}

/** One credential found in a file, described without quoting it. */
export type CredentialFinding = {
  /** Which format matched, for grouping. */
  id: string;
  /** What it is, in words. */
  name: string;
  /** 1-based, so it matches what an editor shows. */
  line: number;
  /*
    Enough of the value to find it in the file and not enough to use.

    A finding gets shown in a window and may end up in a bug report, so it
    carries the prefix — which is the part that identifies the service and is
    not the secret — and nothing else.
  */
  hint: string;
};

/** How much of a match is safe to repeat back. */
function hint(value: string): string {
  const head = value.slice(0, 7);
  return `${head}…`;
}

/**
 * The credentials in this text.
 *
 * Overlapping matches are resolved in favour of whichever pattern is listed
 * first, so a key that fits two formats is named as the more specific one
 * rather than reported twice.
 */
export function findCredentials(text: string): CredentialFinding[] {
  const claimed: Array<[number, number]> = [];
  const found: CredentialFinding[] = [];

  /* Line starts, computed once, so a match's line is a lookup not a scan. */
  const starts: number[] = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    starts.push(at + 1);
  }
  const lineOf = (index: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle]! <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  for (const pattern of CREDENTIAL_PATTERNS) {
    // Fresh each time: a /g regex carries lastIndex between calls.
    const expression = new RegExp(pattern.match.source, pattern.match.flags);
    for (const match of text.matchAll(expression)) {
      const at = match.index ?? 0;
      const to = at + match[0].length;
      if (claimed.some(([from, until]) => at < until && to > from)) continue;
      if (looksLikePlaceholder(match[0])) continue;
      claimed.push([at, to]);
      found.push({
        id: pattern.id,
        name: pattern.name,
        line: lineOf(at),
        hint: hint(match[0]),
      });
    }
  }
  return found.sort((left, right) => left.line - right.line);
}

/**
 * The same text with any credential in it covered over.
 *
 * Used where a file's contents are about to be shown rather than scanned —
 * the diff pane being the case that mattered. The upload warning is careful
 * never to repeat a key back, and the pane behind it was printing one in
 * full, so the same window both refused to show a credential and showed one.
 *
 * The prefix survives, because it names the service and is not the secret,
 * and it is what makes the line recognisable as the one to go and fix. The
 * rest becomes bullets of the same length, so nothing about the shape of the
 * value is lost except the value.
 *
 * Deliberately built on the same patterns and the same placeholder rule as
 * `findCredentials`: if the two disagreed, the pane would either cover
 * something the warning ignored or reveal something it flagged.
 */
export function maskCredentials(text: string): string {
  const claimed: Array<[number, number, string]> = [];

  for (const pattern of CREDENTIAL_PATTERNS) {
    const expression = new RegExp(pattern.match.source, pattern.match.flags);
    for (const match of text.matchAll(expression)) {
      const at = match.index ?? 0;
      const to = at + match[0].length;
      if (claimed.some(([from, until]) => at < until && to > from)) continue;
      if (looksLikePlaceholder(match[0])) continue;
      const value = match[0];
      const keep = value.slice(0, 7);
      claimed.push([at, to, `${keep}${"•".repeat(Math.max(3, value.length - 7))}`]);
    }
  }
  if (!claimed.length) return text;

  claimed.sort((left, right) => left[0] - right[0]);
  let out = "";
  let cursor = 0;
  for (const [at, to, replacement] of claimed) {
    out += text.slice(cursor, at) + replacement;
    cursor = to;
  }
  return out + text.slice(cursor);
}

/**
 * Every assigned value in a line covered over, whatever shape it is.
 *
 * For files that are credentials by their name rather than by their
 * contents. A `.env` holds `TOKEN=<32 random characters>`: it matches no
 * service's format, so the pattern scan cannot see it, and the only thing
 * saying it is a secret is the file it is sitting in. In that file every
 * value is treated as one.
 *
 * The name is kept and the value goes. Which keys are set is the useful part
 * of the diff — that a line was added, and which setting it was — and none
 * of that requires showing what it was set to.
 *
 * A comment is left alone: it is prose, and blanking it makes the file
 * unreadable for no gain.
 */
export function maskAssignedValues(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return text;
  }
  return text.replace(
    /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[:=]\s*)(\S.*)$/,
    (_whole, head: string, value: string) => {
      const bare = value.replace(/^["']|["']$/g, "");
      if (!bare) return text;
      return `${head}${"•".repeat(Math.min(24, Math.max(3, bare.length)))}`;
    },
  );
}

/*
  Extensions worth reading. Everything else is either compiled, compressed, or
  media — a credential in a JPEG is not a case worth slowing every upload for,
  and a scan that reads a repository of video is a scan people turn off.
*/
const READABLE = new Set([
  "",
  ".bash",
  ".bat",
  ".c",
  ".cfg",
  ".clj",
  ".cmd",
  ".conf",
  ".config",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".dart",
  ".dockerfile",
  ".editorconfig",
  ".env",
  ".ex",
  ".exs",
  ".fish",
  ".go",
  ".gradle",
  ".groovy",
  ".h",
  ".hpp",
  ".hcl",
  ".hs",
  ".htm",
  ".html",
  ".ini",
  ".ipynb",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".lua",
  ".m",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".php",
  ".pl",
  ".plist",
  ".properties",
  ".ps1",
  ".psm1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".sbt",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".tf",
  ".tfvars",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

/** Whether a file with this name is worth reading for credentials. */
export function worthReading(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  /*
    A leading dot is the whole name, not an extension: `.env` and `.npmrc`
    are files called that, and treating `env` as their extension would let
    the wrong ones through and read the wrong ones twice.
  */
  const extension = dot <= 0 ? "" : lower.slice(dot);
  if (READABLE.has(extension)) return true;
  // Named files with no extension that are nearly always configuration.
  return ["dockerfile", "makefile", "procfile", "rakefile"].includes(lower);
}

/** Whether these first bytes are text rather than something compiled. */
export function looksLikeText(bytes: Uint8Array): boolean {
  /*
    A NUL byte is the reliable tell. Checking a prefix rather than the whole
    file keeps this cheap, and a file that is text for its first few kilobytes
    and binary after is not a shape that occurs by accident.
  */
  const upTo = Math.min(bytes.byteLength, 8192);
  for (let at = 0; at < upTo; at += 1) if (bytes[at] === 0) return false;
  return true;
}
