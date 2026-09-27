/**
 * The licences somebody can put on a project, and what each one means.
 *
 * A licence is the difference between code a stranger may use and code they
 * may only look at. Most public projects carry none, which reads as generous
 * and is the opposite: with no licence at all, nobody has permission to do
 * anything with the work, and the people most careful about the law are
 * exactly the ones who will walk away.
 *
 * The summaries below are written for somebody deciding, not for a lawyer
 * checking. They say what the licence lets other people do and what it asks
 * of them in return, in one line each, because a picker that only lists
 * identifiers is a picker that makes people choose MIT out of recognition.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { LICENCE_TEXTS } from "./licence_texts";

export type LicenceShape =
  /** Do what you like; keep the notice. */
  | "permissive"
  /** Changes to these files come back; the rest of your work is yours. */
  | "weak-copyleft"
  /** Anything built on it carries the same terms. */
  | "copyleft"
  /** No conditions at all. */
  | "public-domain";

export type Licence = {
  /** The SPDX identifier, which is what every other tool calls it. */
  id: string;
  name: string;
  shape: LicenceShape;
  /** One line, for somebody choosing rather than checking. */
  summary: string;
  /** True where the text has `<year>` and `<copyright holders>` to fill in. */
  personalised: boolean;
};

export const LICENCES: Licence[] = [
  {
    id: "MIT",
    name: "MIT",
    shape: "permissive",
    summary:
      "Anyone may use, change and sell it, as long as they keep your copyright notice.",
    personalised: true,
  },
  {
    id: "Apache-2.0",
    name: "Apache 2.0",
    shape: "permissive",
    summary:
      "Like MIT, and it also grants patent rights and asks that changes be marked. What most companies prefer.",
    personalised: true,
  },
  {
    id: "BSD-3-Clause",
    name: "BSD 3-Clause",
    shape: "permissive",
    summary:
      "Like MIT, and nobody may use your name to promote what they built with it.",
    personalised: true,
  },
  {
    id: "BSD-2-Clause",
    name: "BSD 2-Clause",
    shape: "permissive",
    summary: "MIT in different words, without the naming clause.",
    personalised: true,
  },
  {
    id: "ISC",
    name: "ISC",
    shape: "permissive",
    summary: "MIT, said shorter. Used across the Node ecosystem.",
    personalised: true,
  },
  {
    id: "0BSD",
    name: "Zero-Clause BSD",
    shape: "permissive",
    summary: "Use it however you like, and you do not even have to credit it.",
    personalised: true,
  },
  {
    id: "Zlib",
    name: "zlib",
    shape: "permissive",
    summary:
      "Permissive, with a request that altered versions are not passed off as the original. Common in games.",
    personalised: false,
  },
  {
    id: "BSL-1.0",
    name: "Boost",
    shape: "permissive",
    summary:
      "Permissive, and the notice is not required in compiled form — so it does not follow a binary around.",
    personalised: false,
  },
  {
    id: "MPL-2.0",
    name: "Mozilla Public License 2.0",
    shape: "weak-copyleft",
    summary:
      "Changes to your files must be shared. Anything else built alongside them stays private.",
    personalised: false,
  },
  {
    id: "EPL-2.0",
    name: "Eclipse Public License 2.0",
    shape: "weak-copyleft",
    summary:
      "Like MPL, from the Java world, with its own patent terms. Common in Eclipse and Clojure projects.",
    personalised: false,
  },
  {
    id: "LGPL-3.0-or-later",
    name: "LGPL 3.0",
    shape: "weak-copyleft",
    summary:
      "A closed program may link to it, but changes to the library itself must be published.",
    personalised: false,
  },
  {
    id: "GPL-3.0-or-later",
    name: "GPL 3.0",
    shape: "copyleft",
    summary:
      "Anything built on it must be published under these same terms. Keeps derivatives open.",
    personalised: false,
  },
  {
    id: "GPL-2.0-or-later",
    name: "GPL 2.0",
    shape: "copyleft",
    summary: "The older GPL, still used by the Linux kernel and much beside it.",
    personalised: false,
  },
  {
    id: "AGPL-3.0-or-later",
    name: "AGPL 3.0",
    shape: "copyleft",
    summary:
      "GPL, and it also covers running it as a service — a hosted version must publish its source too.",
    personalised: false,
  },
  {
    id: "Unlicense",
    name: "The Unlicense",
    shape: "public-domain",
    summary: "Given away entirely. No conditions, no attribution, nothing asked.",
    personalised: false,
  },
  {
    id: "CC0-1.0",
    name: "CC0 1.0",
    shape: "public-domain",
    summary:
      "Public domain, worded to work in countries that do not have one. For data and assets more than code.",
    personalised: false,
  },
  {
    id: "CC-BY-4.0",
    name: "Creative Commons BY 4.0",
    shape: "permissive",
    summary:
      "Use it however you like with credit. Meant for writing, images and data — not for code.",
    personalised: false,
  },
  {
    id: "CC-BY-SA-4.0",
    name: "Creative Commons BY-SA 4.0",
    shape: "copyleft",
    summary:
      "Credit, and anything built from it carries the same terms. Meant for writing and images.",
    personalised: false,
  },
];

export const DEFAULT_LICENCE = "MIT";

export function licenceById(id: string): Licence | null {
  const wanted = id.trim().toLowerCase();
  return (
    LICENCES.find((licence) => licence.id.toLowerCase() === wanted) ??
    /* `gpl-3.0` for `GPL-3.0-or-later`, because that is what people type. */
    LICENCES.find((licence) =>
      licence.id.toLowerCase().startsWith(`${wanted}-or-later`),
    ) ??
    null
  );
}

/**
 * The text as it should be written, with the year and holder filled in.
 *
 * Only the licences that carry a copyright line take these. The rest are the
 * same words for everybody, and substituting into them would be editing a
 * legal document — which is exactly what the placeholders exist to avoid.
 */
export function licenceText(
  id: string,
  holder: string,
  year = new Date().getFullYear(),
): string {
  const licence = licenceById(id);
  if (!licence) throw new Error(`No licence called ${id}`);
  const text = LICENCE_TEXTS[licence.id];
  if (!text) throw new Error(`No text vendored for ${licence.id}`);
  if (!licence.personalised) return text;
  return text
    .replace(/<year>/g, String(year))
    .replace(/<copyright holders?>/g, holder);
}

/** The file a licence goes in, which is what every tool looks for. */
export const LICENCE_FILE = "LICENSE";

/**
 * Which licence a file holds, by reading it.
 *
 * Matched on a distinctive line rather than the whole text, because a licence
 * people have edited — a name filled in, a year changed, trailing notes added
 * — is still that licence and should be named as one. A file nobody
 * recognises returns null rather than a guess: saying "MIT" about something
 * that is not MIT is worse than saying nothing.
 */
const FLAT = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/*
  A line that appears in one licence and in no other.

  The first attempt matched each licence's longest line, which is wrong in a
  way that only shows up between relatives: LGPL 3 quotes GPL 3 almost whole,
  BSD 3-Clause is BSD 2-Clause plus a paragraph, and the Unlicense borrows a
  sentence from MIT. Every one of those pairs was answered with the wrong
  member, and a licence named wrongly is worse than one not named at all.

  So the marker for each is the longest line no other licence contains.
  Computed once from the vendored texts rather than written down, because a
  line chosen by hand stops being unique the moment the catalogue grows.
*/
const MARKERS: Array<{ id: string; marker: string; length: number }> = (() => {
  const flattened = LICENCES.map((licence) => ({
    id: licence.id,
    text: FLAT(LICENCE_TEXTS[licence.id] ?? ""),
  }));
  const markers: Array<{ id: string; marker: string; length: number }> = [];
  for (const licence of LICENCES) {
    const canonical = LICENCE_TEXTS[licence.id];
    if (!canonical) continue;
    const candidates = canonical
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter((line) => line.length > 40)
      .sort((left, right) => right.length - left.length);
    const unique = candidates.find((line) => {
      const needle = FLAT(line);
      return !flattened.some(
        (other) => other.id !== licence.id && other.text.includes(needle),
      );
    });
    /*
      A licence with no unique line at all is a subset of another one: every
      line of BSD 2-Clause appears in BSD 3-Clause, which is BSD 2-Clause plus
      a paragraph. Those get their longest line instead, and the ordering
      below is what keeps the answer right — the superset is asked first, so
      the subset is only reached once the longer one has said no.
    */
    const marker = unique ?? candidates[0];
    if (marker) {
      markers.push({
        id: licence.id,
        marker: FLAT(marker),
        length: canonical.length,
      });
    }
  }
  /*
    Longest text first. A licence that quotes another whole — LGPL 3 quoting
    GPL 3, BSD 3-Clause extending BSD 2-Clause — is always the longer of the
    pair, so length is the ordering that puts the more specific one first.
  */
  return markers.sort((left, right) => right.length - left.length);
})();

/**
 * Which licence a file holds, by reading it.
 *
 * Matched on one distinctive line rather than the whole text, because a
 * licence somebody has edited — a name filled in, a year changed, notes
 * appended — is still that licence and should be named as one. A file nobody
 * recognises returns null rather than a guess.
 */
export function detectLicence(text: string): string | null {
  const flat = FLAT(text);
  if (!flat) return null;
  for (const { id, marker } of MARKERS) {
    if (flat.includes(marker)) return id;
  }
  return null;
}

/**
 * Give a new project a licence unless somebody has said otherwise.
 *
 * Work published with no licence cannot legally be used by anybody, which is
 * the opposite of what nearly everyone uploading their work intends. Most
 * people never think about it, so the default decides for them either way,
 * and defaulting to "nobody may use this" serves nobody.
 *
 * Two things keep it a nudge rather than a trick: the caller says so where
 * somebody will read it, and it only ever applies to a project's first save.
 * After that an absent LICENSE is a decision, and putting one back would be
 * arguing with them.
 *
 * Returns the licence written, or null when nothing was.
 */
export async function licenceNewProject(
  folder: string,
  holder: string,
  skip = false,
): Promise<string | null> {
  /*
    No name, no licence. A copyright line naming nobody is worse than the
    absence it replaces, and a save is not the moment to interrupt somebody
    to ask.
  */
  if (skip || !holder.trim()) return null;
  const target = path.join(folder, LICENCE_FILE);
  const already = await readFile(target, "utf8").catch(() => null);
  if (already !== null) return null;
  await writeFile(target, licenceText(DEFAULT_LICENCE, holder.trim()), "utf8");
  return DEFAULT_LICENCE;
}
