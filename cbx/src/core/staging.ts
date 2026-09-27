/**
 * Knowing the whole project before uploading any of it, then sending it in
 * bounded stages.
 *
 * Two separate failures made this necessary.
 *
 * The first was silent. `changedFiles` stops after twenty thousand rows —
 * correctly, because that is a limit on what a list can usefully show — and
 * the upload used the same function to decide what to send. A project past
 * that many files produced a version containing whatever the walk reached
 * first, with nothing anywhere saying the rest existed. A limit meant for a
 * scrollbar was silently deciding what got backed up.
 *
 * The second was unbounded work. Everything was sent in one pass, so memory,
 * progress and the blast radius of an interruption all scaled with the size of
 * the project. A ten gigabyte upload was one attempt that either finished or
 * did not.
 *
 * So: survey everything first, cheaply and without a cap, then divide it into
 * sections with a fixed byte budget. A small project is one section and behaves
 * exactly as it did. A large one is many, each finishing before the next
 * begins, which keeps the working set the same size whatever the project is.
 */

/** One file as the survey found it. Path and size only — nothing is read. */
export type SurveyedFile = {
  path: string;
  size: number;
};

export type Survey = {
  files: SurveyedFile[];
  totalBytes: number;
  /** Counts by size band, which is what decides how each file travels. */
  bands: {
    packable: number;
    ordinary: number;
    chunked: number;
    multipart: number;
  };
};

/**
 * How each file travels, decided by size alone.
 *
 * The bands are the existing routes named: small files compress together into
 * a pack, ordinary ones go as their own object, large ones are cut into
 * content-defined chunks, and anything past the direct limit needs a multipart
 * session. Naming them here means the plan can be inspected before a byte
 * moves.
 */
/*
  Below this a file travels with others in one request rather than alone.

  Measured rather than guessed, twice. The first number was sixty-four
  kilobytes, taken from a source folder where ninety-six percent of files were
  under it. A four and a half gigabyte game then showed the opposite shape:
  eight hundred files of three hundred kilobytes per section, each just above
  that line and so each paying its own round trip.

  What the game measured is the reason for the number. Every request costs
  about six hundred and thirty milliseconds before any bytes move, and the
  lane carries roughly 0.79 MB/s. So a three hundred kilobyte file spends
  sixty percent of its time on overhead and a seven megabyte file spends
  seven. The line belongs where the overhead stops dominating, which is a few
  megabytes and not a few kilobytes.

  Four megabytes was the first attempt and it overshot. Measured on the same
  game twice: four hundred kilobyte files went from 1.80 to 3.24 MB/s when
  batched, while 1.3 megabyte files went from 4.43 down to 3.88 — because
  three concurrent batches move less than six concurrent requests once a file
  is large enough that transfer, not overhead, dominates. The crossover is
  around a megabyte.

  It lives here, and the uploader imports it, because for a while it did not:
  the uploader had measured its way to a megabyte while this file still said
  sixty-four kilobytes, and sections were therefore planned by one definition
  of "small" and then sent by another. Nothing broke, which is why it lasted —
  the planner simply grouped files it called ordinary and the uploader batched
  them anyway, and a second filter downstream existed to paper over the
  disagreement.
*/
export const PACKABLE_LIMIT = 1024 * 1024;
export const CHUNK_THRESHOLD = 8 * 1024 * 1024;
export const DIRECT_LIMIT = 95 * 1024 * 1024;

export type Band = "packable" | "ordinary" | "chunked" | "multipart";

export function bandOf(size: number): Band {
  if (size <= PACKABLE_LIMIT) return "packable";
  if (size <= CHUNK_THRESHOLD) return "ordinary";
  if (size <= DIRECT_LIMIT) return "chunked";
  return "multipart";
}

export function survey(files: SurveyedFile[]): Survey {
  const bands = { packable: 0, ordinary: 0, chunked: 0, multipart: 0 };
  let totalBytes = 0;
  for (const file of files) {
    bands[bandOf(file.size)] += 1;
    totalBytes += file.size;
  }
  return { files, totalBytes, bands };
}

/**
 * How much source a single section may carry.
 *
 * Chosen so the working set stays the same whatever the project is: a section
 * is read, packed, sent and finished before the next one starts, so a thirty
 * gigabyte upload holds no more in memory than a two hundred megabyte one. Big
 * enough that a small project is still one section and behaves exactly as it
 * did before any of this existed.
 */
export const SECTION_BYTES = 256 * 1024 * 1024;

/** How many files one section may carry, however small they are. */
export const SECTION_FILES = 4000;

export type Section = {
  index: number;
  files: SurveyedFile[];
  bytes: number;
};

/**
 * Divide a survey into sections.
 *
 * Files are grouped by band first, so a section is mostly one kind of work —
 * a pack of small files, or a run of large ones — rather than a mixture that
 * makes progress lurch. Within a band they keep their order, so a resumed
 * upload repeats the same plan and skips the same completed sections.
 *
 * A file larger than the whole budget gets a section to itself. It cannot be
 * split across sections, and pretending otherwise would either overflow the
 * budget silently or strand the file.
 */
export function planSections(
  files: SurveyedFile[],
  budget = SECTION_BYTES,
  fileLimit = SECTION_FILES,
): Section[] {
  const order: Band[] = ["packable", "ordinary", "chunked", "multipart"];
  const grouped = new Map<Band, SurveyedFile[]>();
  for (const file of files) {
    const band = bandOf(file.size);
    const held = grouped.get(band) ?? [];
    held.push(file);
    grouped.set(band, held);
  }

  const sections: Section[] = [];
  let current: SurveyedFile[] = [];
  let bytes = 0;

  const close = () => {
    if (!current.length) return;
    sections.push({ index: sections.length, files: current, bytes });
    current = [];
    bytes = 0;
  };

  for (const band of order) {
    for (const file of grouped.get(band) ?? []) {
      /*
        One file bigger than the budget is its own section. Splitting it here
        would mean a section that overflows or a file that never fits, and the
        chunker below the plan already knows how to send it in pieces.
      */
      if (file.size >= budget) {
        close();
        sections.push({ index: sections.length, files: [file], bytes: file.size });
        continue;
      }
      if (bytes + file.size > budget || current.length >= fileLimit) close();
      current.push(file);
      bytes += file.size;
    }
    /*
      Sections do not straddle bands. A section of small files and a section of
      large ones are different shapes of work, and mixing them makes the time
      one takes unpredictable from its size.
    */
    close();
  }
  close();
  return sections;
}

/** A short description of the plan, for somebody deciding whether to start. */
export function describePlan(surveyed: Survey, sections: Section[]): string {
  const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
  return [
    `${surveyed.files.length} files, ${mb(surveyed.totalBytes)}`,
    `${sections.length} section${sections.length === 1 ? "" : "s"}`,
    `${surveyed.bands.packable} packed, ${surveyed.bands.ordinary} ordinary, ` +
      `${surveyed.bands.chunked} chunked, ${surveyed.bands.multipart} multipart`,
  ].join(" · ");
}
