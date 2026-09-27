/**
 * Showing what two people actually did to the same file.
 *
 * The merge screen used to offer four buttons — keep yours, keep theirs, keep
 * both, remove it — above nothing at all. You were asked which side wins for
 * a file you could not look at, which is not a decision so much as a guess,
 * and the safe guess ("keep both") leaves the project holding two copies of
 * everything anybody ever disagreed about.
 *
 * So the two sides are laid out line by line. Nothing here is a merge
 * algorithm: the service already tried that and put the file on a Track
 * precisely because the automatic answer was wrong. This is for reading.
 */

export type LineSide = "same" | "target" | "candidate";

export type DiffLine = {
  side: LineSide;
  /** 1-based line number on the saved side, or null where it has no line. */
  targetLine: number | null;
  /** 1-based line number on the uploaded side, or null. */
  candidateLine: number | null;
  text: string;
};

/**
 * The lines two texts share, longest run first.
 *
 * A plain longest-common-subsequence table. Both sides of a conflicted file
 * are one file's worth of lines, so the quadratic table is a few hundred
 * kilobytes at worst — and the alternative, a heuristic diff, sometimes
 * reports a change where there is none, which on this screen would mean
 * showing somebody a disagreement that does not exist.
 */
function commonRuns(left: string[], right: string[]): number[][] {
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let a = left.length - 1; a >= 0; a -= 1) {
    for (let b = right.length - 1; b >= 0; b -= 1) {
      table[a]![b] =
        left[a] === right[b]
          ? table[a + 1]![b + 1]! + 1
          : Math.max(table[a + 1]![b]!, table[a]![b + 1]!);
    }
  }
  return table;
}

/** Split into lines without inventing a trailing empty one. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * How the saved file and the uploaded file differ, in order.
 *
 * `target` is what the project already held and `candidate` is what was
 * uploaded, named the way the service names them rather than "old" and "new"
 * — neither side is older, which is the whole reason there is a decision to
 * make.
 */
export function diffLines(target: string, candidate: string): DiffLine[] {
  const left = linesOf(target);
  const right = linesOf(candidate);
  const table = commonRuns(left, right);
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) {
      out.push({
        side: "same",
        targetLine: a + 1,
        candidateLine: b + 1,
        text: left[a]!,
      });
      a += 1;
      b += 1;
    } else if (table[a + 1]![b]! >= table[a]![b + 1]!) {
      out.push({ side: "target", targetLine: a + 1, candidateLine: null, text: left[a]! });
      a += 1;
    } else {
      out.push({
        side: "candidate",
        targetLine: null,
        candidateLine: b + 1,
        text: right[b]!,
      });
      b += 1;
    }
  }
  while (a < left.length) {
    out.push({ side: "target", targetLine: a + 1, candidateLine: null, text: left[a]! });
    a += 1;
  }
  while (b < right.length) {
    out.push({
      side: "candidate",
      targetLine: null,
      candidateLine: b + 1,
      text: right[b]!,
    });
    b += 1;
  }
  return out;
}

/**
 * The same lines, with long stretches of agreement folded away.
 *
 * A conflict in a two thousand line file is a handful of lines somebody has
 * to read surrounded by nineteen hundred they do not. `context` lines are
 * kept either side of every difference; what is left becomes a gap saying
 * how much was skipped, so nobody mistakes a fold for the end of the file.
 */
export type DiffChunk =
  | { kind: "lines"; lines: DiffLine[] }
  | { kind: "gap"; skipped: number };

export function foldUnchanged(lines: DiffLine[], context = 3): DiffChunk[] {
  const interesting = new Set<number>();
  lines.forEach((line, index) => {
    if (line.side === "same") return;
    for (
      let at = Math.max(0, index - context);
      at <= Math.min(lines.length - 1, index + context);
      at += 1
    ) {
      interesting.add(at);
    }
  });
  /*
    A file with no differences at all is still worth showing — a conflict can
    be about two people creating the same path with identical content, or
    about a file one side deleted, and folding the whole thing away would
    leave the screen empty with no explanation.
  */
  if (!interesting.size) return [{ kind: "lines", lines }];

  const chunks: DiffChunk[] = [];
  let run: DiffLine[] = [];
  let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (interesting.has(index)) {
      if (skipped) {
        chunks.push({ kind: "gap", skipped });
        skipped = 0;
      }
      run.push(lines[index]!);
    } else {
      if (run.length) {
        chunks.push({ kind: "lines", lines: run });
        run = [];
      }
      skipped += 1;
    }
  }
  if (run.length) chunks.push({ kind: "lines", lines: run });
  if (skipped) chunks.push({ kind: "gap", skipped });
  return chunks;
}

/**
 * A starting point for somebody who wants to edit rather than choose.
 *
 * Both sides, marked the way every merge tool has marked them since RCS, so
 * the text is immediately familiar and every editor already highlights it.
 * Agreed lines appear once; the rest are stacked with the markers between
 * them, and it is the person's job to delete the markers along with whatever
 * they decided against.
 */
export function conflictDraft(
  target: string,
  candidate: string,
  labels: { target: string; candidate: string } = {
    target: "saved on the project",
    candidate: "your upload",
  },
): string {
  const out: string[] = [];
  let held: { target: string[]; candidate: string[] } = { target: [], candidate: [] };
  const flush = () => {
    if (!held.target.length && !held.candidate.length) return;
    out.push(`<<<<<<< ${labels.target}`);
    out.push(...held.target);
    out.push("=======");
    out.push(...held.candidate);
    out.push(`>>>>>>> ${labels.candidate}`);
    held = { target: [], candidate: [] };
  };
  for (const line of diffLines(target, candidate)) {
    if (line.side === "same") {
      flush();
      out.push(line.text);
    } else if (line.side === "target") {
      held.target.push(line.text);
    } else {
      held.candidate.push(line.text);
    }
  }
  flush();
  return out.join("\n");
}

/** Whether any conflict marker is still in the text somebody is about to send. */
export function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7}|={7}|>{7})(?:\s|$)/m.test(text);
}
