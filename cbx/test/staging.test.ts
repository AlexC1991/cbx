import assert from "node:assert/strict";
import test from "node:test";

import {
  bandOf,
  describePlan,
  PACKABLE_LIMIT,
  planSections,
  survey,
} from "../dist/core/staging.js";

/**
 * Deciding what an upload is before starting it.
 *
 * Two failures are being guarded here, and only one of them is about size.
 *
 * The silent one: the list of changes stops at twenty thousand rows, which is
 * right for something a person scrolls and was also deciding what got
 * uploaded. A project past that many files produced a version holding whatever
 * the walk reached first and said nothing about the rest.
 *
 * The loud one: everything went in a single pass, so memory and the cost of an
 * interruption both scaled with the project. Sections bound both.
 */
const file = (path: string, size: number) => ({ path, size });
const MB = 1024 * 1024;

test("routes each file by size alone", () => {
  assert.equal(bandOf(2 * 1024), "packable");
  assert.equal(bandOf(64 * 1024), "packable");
  /*
    A megabyte, not sixty-four kilobytes. The uploader measured its way to
    this line and this file was left on the old one, so sections were planned
    by one definition of "small" and sent by another — the three hundred
    kilobyte file that prompted the measurement sat on the wrong side here
    while being batched anyway.
  */
  assert.equal(bandOf(300 * 1024), "packable");
  assert.equal(bandOf(MB), "packable");
  assert.equal(bandOf(MB + 1), "ordinary");
  assert.equal(bandOf(8 * MB - 1), "ordinary");
  assert.equal(bandOf(8 * MB), "ordinary");
  assert.equal(bandOf(8 * MB + 1), "chunked");
  assert.equal(bandOf(96 * MB), "multipart");
});

test("the planner and the sender agree on what is small", () => {
  /*
    The property that was missing. Two constants meant the disagreement could
    come back silently the next time either was tuned; this fails if they part
    company again.
  */
  assert.equal(PACKABLE_LIMIT, MB);
});

test("a small project is one section", () => {
  /*
    The behaviour that must not change. Most projects are well inside one
    section and should upload exactly as they did before any of this existed.
  */
  const files = Array.from({ length: 500 }, (_, at) =>
    file(`src/file${at}.ts`, 4 * 1024),
  );
  const sections = planSections(files);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].files.length, 500);
});

test("a large project becomes many bounded sections", () => {
  const files = Array.from({ length: 40 }, (_, at) =>
    file(`media/clip${at}.bin`, 20 * MB),
  );
  const sections = planSections(files);
  assert.ok(sections.length > 1, "expected more than one section");
  for (const section of sections) {
    assert.ok(
      section.bytes <= 256 * MB,
      `section ${section.index} carries ${section.bytes} bytes`,
    );
  }
});

test("every file lands in exactly one section", () => {
  /*
    The property the whole thing rests on. A file in two sections is uploaded
    twice; a file in none is the silent truncation this replaces.
  */
  const files = [
    ...Array.from({ length: 9000 }, (_, at) => file(`small/${at}.txt`, 3 * 1024)),
    ...Array.from({ length: 30 }, (_, at) => file(`big/${at}.bin`, 40 * MB)),
    file("huge/one.bin", 700 * MB),
  ];
  const sections = planSections(files);
  const seen = sections.flatMap((section) => section.files.map((one) => one.path));
  assert.equal(seen.length, files.length);
  assert.equal(new Set(seen).size, files.length);
});

test("a file larger than the budget gets a section of its own", () => {
  /*
    It cannot be split across sections. Pretending otherwise would either
    overflow the budget or strand the file; the chunker below the plan already
    knows how to send one large file in pieces.
  */
  const sections = planSections([
    file("a.txt", 1024),
    file("enormous.bin", 900 * MB),
    file("b.txt", 1024),
  ]);
  const alone = sections.find((section) =>
    section.files.some((one) => one.path === "enormous.bin"),
  );
  assert.ok(alone);
  assert.equal(alone.files.length, 1);
});

test("sections do not mix small files with large ones", () => {
  /*
    A section of small files and a section of large ones are different shapes
    of work. Mixed, the time a section takes stops being predictable from its
    size, and progress lurches.
  */
  const files = [
    ...Array.from({ length: 100 }, (_, at) => file(`s/${at}.txt`, 1024)),
    ...Array.from({ length: 4 }, (_, at) => file(`l/${at}.bin`, 30 * MB)),
  ];
  for (const section of planSections(files)) {
    const bands = new Set(section.files.map((one) => bandOf(one.size)));
    assert.equal(bands.size, 1, `section ${section.index} mixes ${[...bands]}`);
  }
});

test("caps how many files one section carries", () => {
  /*
    Bounded by count as well as by bytes: a hundred thousand one-byte files are
    nothing in total and still a hundred thousand pieces of work.
  */
  const files = Array.from({ length: 12000 }, (_, at) =>
    file(`tiny/${at}.txt`, 16),
  );
  for (const section of planSections(files)) {
    assert.ok(section.files.length <= 4000);
  }
});

test("the plan is stable, so a resumed upload repeats it", () => {
  /*
    Resuming skips sections that finished. That only works if planning the same
    project twice produces the same sections in the same order.
  */
  const files = Array.from({ length: 3000 }, (_, at) =>
    file(`src/${at}.ts`, 5 * 1024),
  );
  const first = planSections(files).map((s) => s.files.map((f) => f.path));
  const again = planSections(files).map((s) => s.files.map((f) => f.path));
  assert.deepEqual(first, again);
});

test("counts the project honestly, however many files it holds", () => {
  /*
    Well past the twenty thousand the changes list stops at — the number that
    used to decide, silently, what was uploaded.
  */
  const files = Array.from({ length: 50_000 }, (_, at) =>
    file(`src/${at}.ts`, 2 * 1024),
  );
  const surveyed = survey(files);
  assert.equal(surveyed.files.length, 50_000);
  assert.equal(surveyed.bands.packable, 50_000);
  assert.equal(surveyed.totalBytes, 50_000 * 2 * 1024);
  assert.match(describePlan(surveyed, planSections(files)), /50000 files/);
});

test("an empty project plans nothing rather than failing", () => {
  assert.deepEqual(planSections([]), []);
});
