/**
 * How much of an upload has happened, and how fast it is going.
 *
 * Lifted out of the upload pass because nearly every number a person watches
 * during a save comes from here, and three separate faults have come out of it
 * being a handful of loose counters in the middle of a very long function:
 *
 *   - Six lanes each added their own offset to one shared total, so the figure
 *     jumped between six different answers and the bar ran backwards.
 *   - The rate was `transferred` over the whole elapsed time while the bar
 *     beside it showed something else, so one real upload sat at
 *     "152 MB of 1.1 GB · 10 B/s" — not a slow upload, a number describing a
 *     different thing.
 *   - A lifetime average meant a slow first minute went on dragging the figure
 *     down long after the link had recovered, which is the opposite of what
 *     somebody watching it wants to know.
 *
 * So the counters and the arithmetic over them live together, with names, and
 * can be tested without starting an upload.
 */
export class TransferProgress {
  /** Bytes of files that have finished, whether they travelled or not. */
  private settled = 0;
  /** Bytes that actually crossed the wire. */
  private moved = 0;
  /** Files the service already held, so nothing crossed the wire for them. */
  private reused = 0;
  /*
    How far each lane is through the file it currently holds, kept apart so the
    total is the sum of real work rather than six lanes' guesses about one
    shared number.
  */
  private readonly inFlight = new Map<number, number>();

  private readonly samples: Array<{ at: number; bytes: number }> = [];

  constructor(
    /** How long a window the rate is measured over. */
    private readonly windowMs = 5000,
    /** Injected so a test can move time without waiting for it. */
    private readonly now: () => number = Date.now,
  ) {}

  /** A file finished: its own size, and what it cost to send. */
  finished(sourceBytes: number, wireBytes: number): void {
    this.settled += sourceBytes;
    this.moved += wireBytes;
  }

  /** A file the service already had. Counted apart so "sent" stays honest. */
  alreadyHeld(): void {
    this.reused += 1;
  }

  /** Where one lane has got to inside the file it is sending. */
  lane(index: number, offset: number): void {
    this.inFlight.set(index, offset);
  }

  /** That lane has finished, so its offset is now part of the settled total. */
  laneDone(index: number): void {
    this.inFlight.delete(index);
  }

  /** Everything settled, plus how far the open lanes have got. */
  bytes(): number {
    let total = this.settled;
    for (const offset of this.inFlight.values()) total += offset;
    return total;
  }

  get sentBytes(): number {
    return this.settled;
  }

  get transferred(): number {
    return this.moved;
  }

  get alreadyOnAccount(): number {
    return this.reused;
  }

  /**
   * How fast the thing on screen is moving, over a short trailing window.
   *
   * The same counter the bar uses, so the two agree. Sampled rather than
   * recorded per call: this is asked once per report, and reports arrive per
   * file, which for small files is thousands a second.
   */
  rate(): number {
    const now = this.now();
    const bytes = this.bytes();
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.at >= 250) this.samples.push({ at: now, bytes });
    while (this.samples.length > 2 && now - this.samples[0]!.at > this.windowMs) {
      this.samples.shift();
    }
    const oldest = this.samples[0]!;
    const seconds = (now - oldest.at) / 1000;
    /*
      Nothing until there is something to divide. Answering zero keeps the
      window quiet rather than showing a figure computed from a fraction of a
      second, which reads as a stall on an upload that has barely begun.
    */
    if (seconds < 0.5) return 0;
    return Math.max(0, Math.round((bytes - oldest.bytes) / seconds));
  }
}
