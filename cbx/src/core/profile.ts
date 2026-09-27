/**
 * Where an upload's time actually goes.
 *
 * Written because guessing was wrong twice. The first batching attempt was
 * built on the assumption that HTTP round trips were the cost; they were about
 * a tenth of it, and the real expense was ten database queries per object. The
 * fix for that then revealed object storage as the next bottleneck. Neither
 * would have been found by reading the code.
 *
 * Inert unless CODEROOK_PROFILE is set, so it costs a boolean check on a hot
 * path and nothing else. It reports totals per named phase rather than a trace,
 * because the question is always "which stage is the upload" and never "what
 * happened at 14:32:07".
 */
const enabled = Boolean(process.env.CODEROOK_PROFILE);

type Phase = { total: number; count: number };

const phases = new Map<string, Phase>();

/** Time one awaited step and attribute it to a phase. */
export async function timed<T>(phase: string, work: () => Promise<T>): Promise<T> {
  if (!enabled) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    const held = phases.get(phase) ?? { total: 0, count: 0 };
    held.total += performance.now() - started;
    held.count += 1;
    phases.set(phase, held);
  }
}

/** Count something that is not a duration — files batched, files sent alone. */
export function counted(phase: string, by = 1): void {
  if (!enabled) return;
  const held = phases.get(phase) ?? { total: 0, count: 0 };
  held.count += by;
  phases.set(phase, held);
}

/**
 * What was measured, slowest first.
 *
 * Returns an empty string when profiling is off, so a caller can print it
 * unconditionally without deciding whether there is anything to print.
 */
export function profileReport(): string {
  if (!enabled || !phases.size) return "";
  const rows = [...phases.entries()].sort(
    (left, right) => right[1].total - left[1].total,
  );
  const width = Math.max(...rows.map(([name]) => name.length));
  return [
    "",
    "where the time went:",
    ...rows.map(([name, phase]) => {
      const seconds = (phase.total / 1000).toFixed(1);
      const each =
        phase.count && phase.total
          ? ` (${(phase.total / phase.count).toFixed(1)}ms each)`
          : "";
      return phase.total
        ? `  ${name.padEnd(width)}  ${seconds.padStart(7)}s  ×${phase.count}${each}`
        : `  ${name.padEnd(width)}  ${String(phase.count).padStart(8)}`;
    }),
  ].join("\n");
}

export function resetProfile(): void {
  phases.clear();
}
