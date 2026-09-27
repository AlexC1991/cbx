/**
 * Showing a run as it happens.
 *
 * The runner used to print the name of a job, fall silent for however long the
 * work took, and then print the result. For a five-second echo that is merely
 * odd; for a ten-minute build it means watching a blank terminal with no way
 * to tell compiling from hung from waiting on a prompt that will never be
 * answered. Every byte of output was being captured and shipped to the
 * service, and none of it shown to the person sitting in front of it.
 *
 * Two things fix that, and they are different problems.
 *
 * The fetch has a known total — the version says how many files it holds — so
 * that gets a real bar with a real percentage. The command does not: nothing
 * knows how long `npm run build` takes, and a bar that invents a percentage is
 * worse than no bar, because people plan around it. That phase gets a spinner,
 * an elapsed clock, and the command's own output as it arrives, which is the
 * honest answer to "what is it doing".
 */

import process from "node:process";

/** Braille frames: dense, monospaced, and they animate in one column. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const dim = (value: string) => `[2m${value}[0m`;
const accent = (value: string) => `[33m${value}[0m`;

/**
 * Whether to animate at all.
 *
 * A spinner written to a file or a CI log is thousands of lines of escape
 * codes nobody can read. When there is no terminal, phases are announced once
 * as plain lines and nothing rewrites itself.
 */
const live = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function clock(from: number): string {
  const seconds = Math.floor((Date.now() - from) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes
    ? `${minutes}:${String(seconds % 60).padStart(2, "0")}`
    : `${seconds}s`;
}

/**
 * A bar drawn from block characters, for a phase that knows its own size.
 *
 * Shared with push, pull and get, which had a percentage and no bar. `fade` is
 * a parameter because the commands honour NO_COLOR through their own helper,
 * and a track drawn with escape codes somebody asked not to receive is worse
 * than an undimmed one.
 */
export function bar(
  fraction: number,
  width = 18,
  fade: (value: string) => string = dim,
): string {
  const safe = Number.isFinite(fraction) ? fraction : 0;
  /*
    Floored, so the bar fills only when the work is actually done. Rounding
    drew a solid bar from 97% onwards, which is the same lie the percentage
    used to tell — just harder to argue with.
  */
  const filled = Math.max(0, Math.min(width, Math.floor(safe * width)));
  return `${"█".repeat(filled)}${fade("░".repeat(width - filled))}`;
}

export class RunProgress {
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private phase = "";
  private detail = "";
  private fraction: number | null = null;
  private readonly started = Date.now();
  private painted = false;

  /**
   * Move to a new phase.
   *
   * `fraction` is only passed where something real is being counted. Left out,
   * the line shows a spinner and an elapsed time instead of a made-up number.
   */
  step(phase: string, detail = "", fraction: number | null = null): void {
    const previous = this.phase;
    this.phase = phase;
    this.detail = detail;
    this.fraction = fraction;
    if (!live) {
      /*
        Without a terminal each phase is announced once, rather than repeating
        the same line every time a file lands.
      */
      if (phase !== previous) console.log(`  ${phase}${detail ? `: ${detail}` : ""}`);
      return;
    }
    this.paint();
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        this.paint();
      }, 90);
      this.timer.unref?.();
    }
  }

  /**
   * Update the counted part of the current phase without changing it.
   *
   * Records the numbers and leaves the drawing to the spinner's own timer. A
   * version with thirty thousand files calls this thirty thousand times, and
   * repainting on each one is thirty thousand writes to render eleven frames
   * a person can actually read — the download ends up waiting on the
   * terminal.
   */
  advance(detail: string, fraction: number | null = null): void {
    this.detail = detail;
    this.fraction = fraction;
  }

  /**
   * Output the command itself printed.
   *
   * Cleared out of the way first so the text and the status line do not fight
   * over the same row, then the status line is drawn again underneath — which
   * keeps the newest output directly above where the progress is. A whole
   * chunk at a time, because a build that prints a hundred lines in one breath
   * should cost one repaint rather than a hundred.
   */
  say(chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (!lines.length) return;
    if (!live) {
      for (const line of lines) console.log(`    ${line.replace(/\s+$/, "")}`);
      return;
    }
    this.clear();
    for (const line of lines) console.log(`    ${dim(line.replace(/\s+$/, ""))}`);
    this.paint();
  }

  /**
   * Stop, and take the status line with it.
   *
   * Deliberately silent. The runner already prints the verdict — which is the
   * line somebody scrolls back to — and a progress display that also announced
   * the result would say the same thing twice, differently.
   */
  done(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }

  private clear(): void {
    if (!live || !this.painted) return;
    process.stdout.write("\r[2K");
    this.painted = false;
  }

  private paint(): void {
    if (!live) return;
    const spinner = accent(FRAMES[this.frame] ?? "⠋");
    const measured =
      this.fraction === null
        ? ""
        : /*
             Floored to agree with the bar. Rounding printed 100% beside a bar
             with a block still to fill, and two readings of the same number
             disagreeing is worse than either of them being pessimistic.
           */
          `${bar(this.fraction)} ${String(Math.floor(this.fraction * 100)).padStart(3)}%  `;
    const line = `${spinner} ${this.phase}  ${measured}${dim(this.detail)}  ${dim(clock(this.started))}`;
    /*
      Truncated to the terminal so a long file path does not wrap and leave
      half a status line stranded above the next repaint.
    */
    const width = process.stdout.columns ?? 80;
    process.stdout.write(`\r[2K${line.slice(0, width + 40)}`);
    this.painted = true;
  }
}
