import { strict as assert } from "node:assert";
import test from "node:test";

import { TransferProgress } from "../dist/core/transfer_progress.js";

/**
 * The numbers a person watches while a save runs.
 *
 * Every one of these is a fault that shipped. They were loose counters and two
 * closures in the middle of a twelve-hundred-line function, where nothing about
 * them could be exercised without starting a real upload — which is why each
 * was found by somebody watching a progress bar rather than by a test.
 */

test("counts what settled and what actually travelled, apart", () => {
  const progress = new TransferProgress();
  progress.finished(1000, 1000);
  /* A file the service already held: its size counts, its wire cost does not. */
  progress.finished(4000, 0);
  progress.alreadyHeld();
  assert.equal(progress.sentBytes, 5000);
  assert.equal(progress.transferred, 1000);
  assert.equal(progress.alreadyOnAccount, 1);
});

test("sums the open lanes instead of letting them fight over one total", () => {
  /*
    The backwards bar. With one worker "everything finished plus how far I am"
    was true; with six, each lane added its own offset to the same shared
    number and the reported figure jumped between six different answers.
  */
  const progress = new TransferProgress();
  progress.finished(1000, 1000);
  progress.lane(0, 300);
  progress.lane(1, 500);
  assert.equal(progress.bytes(), 1800);
  progress.lane(0, 900);
  assert.equal(progress.bytes(), 2400, "a lane moving on does not double-count");
  progress.laneDone(0);
  assert.equal(progress.bytes(), 1500, "its offset leaves with it");
});

test("never goes backwards while a lane is filling", () => {
  const progress = new TransferProgress();
  let last = 0;
  for (const offset of [0, 100, 250, 400, 900]) {
    progress.lane(3, offset);
    const now = progress.bytes();
    assert.ok(now >= last, `${now} should not be below ${last}`);
    last = now;
  }
});

test("reports nothing until there is enough time to divide by", () => {
  /*
    A figure computed from a fraction of a second reads as a stall on an upload
    that has barely begun.
  */
  let clock = 1_000_000;
  const progress = new TransferProgress(5000, () => clock);
  progress.finished(1_000_000, 1_000_000);
  assert.equal(progress.rate(), 0);
  clock += 200;
  assert.equal(progress.rate(), 0);
});

test("measures the rate over a trailing window, not the whole upload", () => {
  /*
    The "152 MB of 1.1 GB · 10 B/s" reading. A lifetime average let a slow first
    minute drag the figure down long after the link had recovered — the opposite
    of what somebody watching it wants to know.
  */
  let clock = 1_000_000;
  const progress = new TransferProgress(5000, () => clock);

  /* Ten seconds of almost nothing. */
  for (let step = 0; step < 10; step += 1) {
    clock += 1000;
    progress.finished(10, 10);
    progress.rate();
  }
  /* Then five seconds at a megabyte a second. */
  for (let step = 0; step < 5; step += 1) {
    clock += 1000;
    progress.finished(1_000_000, 1_000_000);
    progress.rate();
  }
  const now = progress.rate();
  assert.ok(
    now > 500_000,
    `the recent megabytes should dominate, got ${now.toLocaleString()} B/s`,
  );
});

test("reports the same counter the bar shows", () => {
  /*
    The two disagreed: the rate came from bytes that had crossed the wire while
    the bar showed everything settled, so a save of mostly-reused files looked
    stalled while it was in fact nearly done.
  */
  let clock = 1_000_000;
  const progress = new TransferProgress(5000, () => clock);
  progress.rate();
  clock += 2000;
  /* Four megabytes settled, none of which travelled. */
  progress.finished(4_000_000, 0);
  assert.equal(progress.transferred, 0);
  assert.ok(
    progress.rate() > 0,
    "a save that reuses everything is still making progress",
  );
});
