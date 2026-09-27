/**
 * A three-way merge of text: what two people did to the same starting point.
 *
 * The shared diff in `shared/merge_diff` compares two sides, which is all a
 * conflict on CodeRook needs because the service already knows the base. A
 * local merge has the base too, and using it is the whole difference between
 * a merge and a comparison: a line only one side touched is taken without
 * asking, and only a line both sides changed differently is a conflict.
 *
 * Lines keep their own endings, so a file with CRLF endings comes out with
 * CRLF endings, and nothing is normalised that nobody asked to change.
 */

/*
  The most comparison cells one line match may fill. The match is an exact
  longest-common-subsequence, quadratic in the lines that differ once the
  shared start and end are set aside; past this the file is not merged line
  by line and is reported as a conflict instead.
*/
const CELL_LIMIT = 16_000_000;

/** Lines with their endings, so joining them gives back the exact text. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split(/(?<=\n)/);
}

/**
 * For each line of `from`, the line of `to` it is matched with, or -1.
 * Null when the files differ too widely to match affordably.
 */
function match(from: string[], to: string[]): Int32Array | null {
  const matched = new Int32Array(from.length).fill(-1);
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) {
    matched[start] = start;
    start += 1;
  }
  let end = 0;
  while (
    end < from.length - start &&
    end < to.length - start &&
    from[from.length - 1 - end] === to[to.length - 1 - end]
  ) {
    matched[from.length - 1 - end] = to.length - 1 - end;
    end += 1;
  }
  const rows = from.length - start - end;
  const columns = to.length - start - end;
  if (!rows || !columns) return matched;
  if ((rows + 1) * (columns + 1) > CELL_LIMIT) return null;

  /* Suffix table: table[a][b] is the LCS length of from[a..] and to[b..]. */
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let a = rows - 1; a >= 0; a -= 1) {
    for (let b = columns - 1; b >= 0; b -= 1) {
      table[a * width + b] =
        from[start + a] === to[start + b]
          ? table[(a + 1) * width + b + 1]! + 1
          : Math.max(table[(a + 1) * width + b]!, table[a * width + b + 1]!);
    }
  }
  let a = 0;
  let b = 0;
  while (a < rows && b < columns) {
    if (from[start + a] === to[start + b]) {
      matched[start + a] = start + b;
      a += 1;
      b += 1;
    } else if (table[(a + 1) * width + b]! >= table[a * width + b + 1]!) {
      a += 1;
    } else {
      b += 1;
    }
  }
  return matched;
}

const same = (left: string[], right: string[]) =>
  left.length === right.length && left.every((line, at) => line === right[at]);

export type TextMerge = {
  text: string;
  /** How many places both sides changed differently. */
  conflicts: number;
};

/**
 * Merge `ours` and `theirs`, both descended from `base`.
 *
 * Null when the files are too different to match line by line; the caller
 * treats the whole file as one conflict.
 */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  labels: { ours: string; theirs: string } = { ours: "ours", theirs: "theirs" },
): TextMerge | null {
  const o = splitLines(base);
  const a = splitLines(ours);
  const b = splitLines(theirs);
  const toA = match(o, a);
  const toB = match(o, b);
  if (!toA || !toB) return null;

  const eol = ours.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let conflicts = 0;
  let i = 0;
  let j = 0;
  let k = 0;

  const settle = (baseSlice: string[], oursSlice: string[], theirsSlice: string[]) => {
    if (same(oursSlice, baseSlice)) out.push(...theirsSlice);
    else if (same(theirsSlice, baseSlice)) out.push(...oursSlice);
    else if (same(oursSlice, theirsSlice)) out.push(...oursSlice);
    else {
      conflicts += 1;
      /* A side that ends without a newline would run into the marker. */
      const ended = (lines: string[]) => {
        const copy = [...lines];
        const last = copy[copy.length - 1];
        if (last !== undefined && !last.endsWith("\n")) copy[copy.length - 1] = last + eol;
        return copy;
      };
      out.push(`<<<<<<< ${labels.ours}${eol}`, ...ended(oursSlice), `=======${eol}`);
      out.push(...ended(theirsSlice), `>>>>>>> ${labels.theirs}${eol}`);
    }
  };

  for (;;) {
    /* The next base line both sides kept, at or after where we are. */
    let stable = i;
    while (stable < o.length && (toA[stable]! < j || toB[stable]! < k)) stable += 1;
    if (stable === o.length) {
      settle(o.slice(i), a.slice(j), b.slice(k));
      break;
    }
    const nextA = toA[stable]!;
    const nextB = toB[stable]!;
    if (stable === i && nextA === j && nextB === k) {
      out.push(o[i]!);
      i += 1;
      j += 1;
      k += 1;
      continue;
    }
    settle(o.slice(i, stable), a.slice(j, nextA), b.slice(k, nextB));
    i = stable;
    j = nextA;
    k = nextB;
  }
  return { text: out.join(""), conflicts };
}
