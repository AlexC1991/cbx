import assert from "node:assert/strict";
import test from "node:test";

import {
  rulesFromSuggestions,
  suggestBulkDirectories,
  suggestExclusions,
  SUGGESTED_HEADING,
  templatesFor,
} from "../dist/core/detect.js";

/**
 * Proposing what to leave out of an upload.
 *
 * The failure this exists to prevent is a real one that happened: a project
 * folder holding a browser profile, a virtual environment and three release
 * zips was added whole, and the save died on a lock file inside the profile
 * that another program was holding open. Six hundred megabytes were selected
 * and none of it was the work.
 *
 * The rule that governs everything here is that it proposes and never decides.
 * A suggestion nobody accepted must change nothing at all.
 */
const file = (path: string, size = 1024) => ({ path, size });

test("finds the usual generated output", () => {
  const found = suggestExclusions([
    file("src/main.ts"),
    file("node_modules/react/index.js", 5000),
    file("node_modules/react/package.json", 500),
  ]);
  const packages = found.find((one) => one.pattern === "node_modules/");
  assert.ok(packages);
  assert.equal(packages.files, 2);
  assert.equal(packages.bytes, 5500);
  assert.equal(packages.recommended, true);
});

test("says nothing about a folder that is only work", () => {
  /*
    Silence is the right output for a tidy project. A detector that always has
    an opinion trains people to dismiss it without reading.
  */
  const found = suggestExclusions([
    file("src/main.ts"),
    file("README.md"),
    file("src/app/page.tsx"),
  ]);
  assert.deepEqual(found, []);
});

test("recognises a browser profile left in the project", () => {
  const found = suggestExclusions([
    file("Local Storage/leveldb/000005.ldb"),
    file("Local Storage/leveldb/LOCK", 0),
    file("IndexedDB/https_x.indexeddb.leveldb/CURRENT"),
  ]);
  const patterns = found.map((one) => one.pattern);
  assert.ok(patterns.includes("Local Storage/"));
  assert.ok(patterns.includes("IndexedDB/"));
  /*
    The reason names the consequence rather than the category, because the
    consequence is what makes this one worth acting on: a file another program
    holds open stops the save outright.
  */
  const storage = found.find((one) => one.pattern === "Local Storage/");
  assert.match(storage.reason, /keeps open/);
});

test("offers but does not recommend anything that might be the work", () => {
  /*
    "dist" is usually build output and is sometimes hand-written. Ticking it
    for somebody would be deciding, which is the one thing this must not do.
  */
  const found = suggestExclusions([file("dist/bundle.js", 9000)]);
  assert.equal(found[0].pattern, "dist/");
  assert.equal(found[0].recommended, false);
});

test("puts the biggest saving first", () => {
  const found = suggestExclusions([
    file("__pycache__/small.pyc", 10),
    file("node_modules/big/index.js", 900_000),
  ]);
  assert.equal(found[0].pattern, "node_modules/");
});

test("counts a file once, under the rule that explains it", () => {
  /*
    A .pyc inside __pycache__ matches two rules. Counting it twice would
    overstate both suggestions and make the totals add up to more than the
    folder holds.
  */
  const found = suggestExclusions([file("__pycache__/thing.pyc", 400)]);
  const total = found.reduce((sum, one) => sum + one.bytes, 0);
  assert.equal(total, 400);
});

test("accepting nothing writes nothing", () => {
  /* The whole guarantee, in one assertion. */
  assert.equal(rulesFromSuggestions([]), "");
});

test("writes only what was accepted", () => {
  const found = suggestExclusions([
    file("node_modules/a.js", 10),
    file("dist/b.js", 10),
  ]);
  const accepted = found.filter((one) => one.pattern === "node_modules/");
  const rules = rulesFromSuggestions(accepted);
  assert.match(rules, /node_modules\//);
  assert.doesNotMatch(rules, /dist\//);
});

/**
 * Game engines, which is the shape of project this got wrong for longest.
 *
 * A Unity folder produced no suggestions at all: none of the rules knew any
 * of its directory names, so the one kind of project where the answer to
 * "what should I leave out?" is ninety-eight per cent of the folder was the
 * one the detector had nothing to say about. The numbers below are the real
 * ones from the project that surfaced it — 45,398 files of import cache
 * against 1,610 files of game.
 */
test("a Unity project is mostly not the project, and it says so", () => {
  const found = suggestExclusions([
    file("Assets/Scripts/Player.cs", 4000),
    file("Assets/Scenes/Main.unity", 90000),
    file("Library/PackageCache/com.unity.burst/x.dll", 5_000_000),
    file("Library/ShaderCache/a.bin", 3_000_000),
    file("Logs/AssetImportWorker0.log", 20_000),
    file("obj/Debug/Assembly-CSharp.dll", 8000),
    file("UserSettings/Layouts/default.dwlt", 400),
  ]);
  const cache = found.find((one) => one.pattern === "/Library/");
  assert.ok(cache, "Library/ was not offered");
  assert.equal(cache.files, 2);
  assert.equal(cache.bytes, 8_000_000);
  assert.equal(cache.recommended, true);

  // Biggest first, because the decision is about how long the save will take.
  assert.equal(found[0]?.pattern, "/Library/");

  for (const pattern of ["/Logs/", "/obj/", "/UserSettings/"]) {
    assert.ok(
      found.some((one) => one.pattern === pattern && one.recommended),
      `${pattern} was not offered as recommended`,
    );
  }
  // The work itself is never proposed.
  assert.ok(!found.some((one) => one.pattern.startsWith("Assets")));
});

test("an Unreal project keeps Saved for a person to judge", () => {
  const found = suggestExclusions([
    file("Source/Game/Player.cpp", 3000),
    file("Intermediate/Build/x.obj", 1_000_000),
    file("DerivedDataCache/a.udd", 2_000_000),
    file("Binaries/Win64/Game.dll", 500_000),
    file("Saved/Autosaves/Map.umap", 700_000),
  ]);
  const named = new Map(found.map((one) => [one.pattern, one]));
  assert.equal(named.get("/Intermediate/")?.recommended, true);
  assert.equal(named.get("/DerivedDataCache/")?.recommended, true);
  assert.equal(named.get("/Binaries/")?.recommended, true);
  /*
    Named like the work. Unreal keeps logs and autosaves in it, so it is worth
    offering — but ticking it on somebody's behalf is the kind of confident
    wrong that this whole file exists to avoid.
  */
  assert.equal(named.get("/Saved/")?.recommended, false);
});

/**
 * Capitals, which every engine disagrees about.
 *
 * Unity ships `Library` and `obj` in one project; a case-exact match caught
 * whichever spelling the rule happened to be written in and silently missed
 * the other. What gets written back has to be the name that is on disk, or
 * the accepted suggestion excludes a folder that does not exist.
 */
test("a directory is recognised whatever its capitals, and written as found", () => {
  const found = suggestExclusions([
    file("library/ShaderCache/a.bin", 2048),
    file("LIBRARY/other/b.bin", 1024),
  ]);
  const patterns = found.map((one) => one.pattern).sort();
  assert.deepEqual(patterns, ["/LIBRARY/", "/library/"]);
  assert.ok(found.every((one) => one.recommended));
});

/**
 * Vendored dependencies, which are usually most of the files and sometimes the
 * point of the repository.
 *
 * A Go project that vendors its dependencies commits them deliberately, so
 * this is asked about and never ticked — and for the same reason it is kept
 * out of the starter template, which applies with nobody looking.
 */
test("offers vendored dependencies without recommending them", () => {
  const found = suggestExclusions([
    file("vendor/github.com/x/y.go", 4096),
    file("internal/service.go", 2048),
  ]);
  const vendor = found.find((one) => one.pattern === "vendor/");
  assert.ok(vendor, "vendor/ should be offered");
  assert.equal(vendor.recommended, false);
});

/**
 * The folder no list of names could have known about.
 *
 * Every other rule here recognises a folder by its name, which cannot work for
 * the one somebody invented. This repository's own `work/` was 63,210 of the
 * 64,554 files it would have sent — a test harness's scratch output, named
 * nothing in particular, matched by nothing.
 */
test("asks about one huge folder that holds no source", () => {
  const files = [
    ...Array.from({ length: 3000 }, (_, at) => file(`work/run/${at}.dat`, 400)),
    ...Array.from({ length: 40 }, (_, at) => file(`src/unit-${at}.ts`, 2048)),
  ];
  const bulk = suggestBulkDirectories(files);
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].pattern, "work/");
  assert.equal(bulk[0].files, 3000);
  assert.equal(
    bulk[0].recommended,
    false,
    "the same shape is also what a real dataset looks like",
  );
  /* And it arrives through the ordinary channel, so every caller gets it. */
  assert.ok(suggestExclusions(files).some((one) => one.pattern === "work/"));
});

test("one folder is offered once, however the two rules spell it", () => {
  /*
    Unity's Library is named by a rule — the editor rebuilds it — and it is
    also a very large folder with no source in it, so both halves of the
    suggestion list had something to say about it. They spell it differently:
    the rule is anchored to the root and writes `/Library/`, the bulk check
    writes `Library/`, and a dedupe comparing the two as text found no match.

    A real Unity project was then offered its own import cache twice, one
    line under the other, with two different reasons and the same 37,000
    files. Which is the same defect as comparing files by where they sit
    rather than by what they are, in a different costume.
  */
  const files = [
    ...Array.from({ length: 3000 }, (_, at) => file(`Library/Artifacts/${at}.info`, 400)),
    ...Array.from({ length: 40 }, (_, at) => file(`Assets/Scripts/S${at}.cs`, 2048)),
  ];
  const offered = suggestExclusions(files);
  const aboutLibrary = offered.filter((one) =>
    one.pattern.replace(/[/]/g, "").toLowerCase() === "library",
  );
  assert.equal(
    aboutLibrary.length,
    1,
    `Library offered ${aboutLibrary.length} times: ${aboutLibrary.map((o) => o.pattern).join(", ")}`,
  );
  /* And it is the rule's own answer that survives, not "no source in it". */
  assert.equal(aboutLibrary[0].recommended, true);
});

test("leaves a folder of source alone however large it is", () => {
  const files = Array.from({ length: 5000 }, (_, at) =>
    file(`packages/core/src/module-${at}.ts`, 2048),
  );
  assert.deepEqual(suggestBulkDirectories(files), []);
});

test("leaves a game's art alone, because the art is the work", () => {
  /*
    The calibration case. Four thousand images in a six-and-a-half thousand
    file project holds no source by this test's own measure, and asking about
    it would be asking somebody whether their art is generated.
  */
  const files = [
    ...Array.from({ length: 2500 }, (_, at) => file(`src/unit-${at}.ts`, 400)),
    ...Array.from({ length: 4000 }, (_, at) => file(`assets/${at}.png`, 400)),
  ];
  assert.deepEqual(suggestBulkDirectories(files), []);
});

test("defers to a rule that has a better reason than size", () => {
  /*
    node_modules is already recognised by name, with a reason that explains
    itself. Reporting it twice — once as itself and once as "a big folder" —
    would be the same suggestion wearing two hats.
  */
  const files = Array.from({ length: 3000 }, (_, at) =>
    file(`node_modules/pkg-${at}/index.js`, 400),
  );
  const patterns = suggestExclusions(files).map((one) => one.pattern);
  assert.deepEqual(patterns, ["node_modules/"]);
});

/**
 * One heading, not three.
 *
 * The same idea — "these were suggested and somebody accepted them" — was
 * written three different ways in three places, so a .gitignore could end up
 * carrying all three over one folder's lifetime. The tick screen keeps its own
 * separate heading, because that block says something else and is rewritten
 * wholesale rather than added to.
 */
test("records accepted suggestions under the one shared heading", () => {
  const written = rulesFromSuggestions([
    { pattern: "Library/", reason: "cache", bytes: 1, files: 1, recommended: true },
  ]);
  assert.ok(written.startsWith(SUGGESTED_HEADING));
  assert.ok(written.includes("Library/"));
  assert.equal(rulesFromSuggestions([]), "");
});

/**
 * Which of github/gitignore's templates a folder is asking for.
 *
 * The templates were vendored from the start and nothing ever chose one, so
 * every folder got the same generic starter. That list is written for the
 * JavaScript and Python worlds — `build/`, `dist/`, `out/`, `models/**`, none
 * of them anchored — and in a game project those names are ordinary asset
 * folders. A real Unity upload came back missing things because of it.
 */
test("a Unity project is recognised by what Unity requires", () => {
  assert.deepEqual(
    templatesFor(["Assets", "Packages", "ProjectSettings", "Library", "README.md"]),
    ["unity"],
  );
});

test("the engine is decided before the languages", () => {
  /*
    A Unity project has a package.json somewhere and C# everywhere, and its
    own template is the only one that knows `Assets` is content rather than
    build output. So the engine wins, and node is not also applied at the
    root where its unanchored rules would reach into the project.
  */
  assert.deepEqual(
    templatesFor(["Assets", "ProjectSettings", "package.json"]),
    ["unity", "node"],
  );
  assert.equal(templatesFor(["Game.uproject", "Source"])[0], "unrealengine");
  assert.equal(templatesFor(["project.godot", "scenes"])[0], "godot");
});

test("a folder that is nothing in particular still gets the starter", () => {
  assert.deepEqual(templatesFor(["notes.txt", "photos"]), []);
});

test("several honest languages are all named", () => {
  assert.deepEqual(
    templatesFor(["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]),
    ["node", "python", "rust", "go"],
  );
});

test("an engine's own project files do not stack another template on top", () => {
  /*
    The worst thing this could have shipped.

    Unity writes the .sln and the .csproj itself, so a Unity folder looks like
    a Visual Studio project to anything matching on file names. GitHub's
    VisualStudio template ignores `*.meta` — build output, in the .NET world —
    and in Unity that is the sidecar carrying every asset's GUID. Stacked on a
    real project it selected 13,689 of them for removal, which is precisely
    the broken-materials mess this work started from.
  */
  assert.deepEqual(
    templatesFor(["Assets", "ProjectSettings", "SpaceGame.sln", "Assembly-CSharp.csproj"]),
    ["unity"],
  );
  /* And a folder that really is only a solution still gets it. */
  assert.deepEqual(templatesFor(["App.sln", "src"]), ["visualstudio"]);
});

/**
 * A folder named like an engine's output, but inside the work.
 *
 * `obj` is where a C# build writes and also where somebody keeps 3D models;
 * `Binaries` is Unreal's compiled output and also an ordinary name for a
 * folder of native plugins. Offered unanchored, this screen proposed leaving
 * out `Assets/Props/obj` on a real Unity project — the very file the ignore
 * rules had just been fixed to protect. github/gitignore anchors all of
 * these for the same reason.
 */
test("an engine's output is only offered where the engine writes it", () => {
  const inside = suggestExclusions([
    file("Assets/Props/obj/table.obj", 4096),
    file("Assets/Plugins/Binaries/native.dll", 8192),
    file("Assets/Art/Library/atlas.png", 2048),
  ]);
  assert.deepEqual(inside, [], "a folder inside the work was offered for removal");

  const atRoot = suggestExclusions([
    file("obj/Debug/Assembly-CSharp.dll", 4096),
    file("Library/Artifacts/a.dat", 2048),
  ]);
  assert.deepEqual(
    atRoot.map((one) => one.pattern).sort(),
    ["/Library/", "/obj/"],
  );
});

/**
 * The folder that is enormous without holding many files.
 *
 * Every threshold in the detector counted files, and a real project slipped
 * under all of them: 253 files, of which 73 sat in `output/` — thirteen `.gguf`
 * model weights, 10.67 GB, 99% of everything the save would have sent. Nothing
 * was suggested, the app set out to upload all of it, and it never finished.
 * The project still has no version.
 */
const GB = 1024 * 1024 * 1024;

test("asks about a folder that is most of the upload by size", () => {
  const files = [
    ...Array.from({ length: 13 }, (_, at) => file(`output/model-${at}.gguf`, GB)),
    ...Array.from({ length: 60 }, (_, at) => file(`output/run-${at}.json`, 4096)),
    ...Array.from({ length: 180 }, (_, at) => file(`core/unit-${at}.py`, 2048)),
  ];
  const bulk = suggestBulkDirectories(files);
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].pattern, "output/");
  assert.match(
    bulk[0].reason,
    /GB of/,
    `argued in bytes, not files: ${bulk[0].reason}`,
  );
  assert.equal(
    bulk[0].recommended,
    false,
    "13 GB of weights might still be the work — asked, never ticked",
  );
  assert.ok(suggestExclusions(files).some((one) => one.pattern === "output/"));
});

test("far too few files for the count rule, and asked anyway", () => {
  /*
    The whole point. 73 of 253 files is 29% of the count and clears no
    count-based threshold there has ever been here.
  */
  const files = [
    ...Array.from({ length: 13 }, (_, at) => file(`output/model-${at}.gguf`, GB)),
    ...Array.from({ length: 240 }, (_, at) => file(`core/unit-${at}.py`, 2048)),
  ];
  assert.ok(files.length < 2_000, "below the count threshold, as the real one was");
  assert.equal(suggestBulkDirectories(files)[0]?.pattern, "output/");
});

test("stays quiet about a large folder that is not most of the project", () => {
  /* Share, not size. A gigabyte inside thirteen is nobody's problem. */
  const files = [
    file("output/one.bin", GB),
    ...Array.from({ length: 12 }, (_, at) => file(`payload/pack-${at}.bin`, GB)),
  ];
  const offered = suggestBulkDirectories(files).map((one) => one.pattern);
  assert.ok(!offered.includes("output/"), `offered ${offered.join(", ")}`);
});

test("leaves a game's art alone by size, as it already does by count", () => {
  /*
    The calibration case, in the other currency. A game is mostly art by bytes
    — far more reliably than it is by file count — so a size rule that only
    asked "is there source in here" would offer to leave the game out of the
    save. That folder has a name in the count rule's tests for the same reason.
  */
  const files = [
    ...Array.from({ length: 12 }, (_, at) => file(`assets/env-${at}.png`, GB)),
    ...Array.from({ length: 40 }, (_, at) => file(`src/s${at}.cs`, 2048)),
  ];
  assert.deepEqual(suggestBulkDirectories(files), []);
});

test("a folder of weights beside a little art is still weights", () => {
  /*
    Weighted by bytes, not by how many of each there are. A preview image next
    to ten gigabytes of model output must not make the output look authored.
  */
  const files = [
    ...Array.from({ length: 10 }, (_, at) => file(`output/model-${at}.gguf`, GB)),
    ...Array.from({ length: 300 }, (_, at) => file(`output/preview-${at}.png`, 64 * 1024)),
    ...Array.from({ length: 40 }, (_, at) => file(`src/s${at}.py`, 2048)),
  ];
  assert.equal(suggestBulkDirectories(files)[0]?.pattern, "output/");
});

test("stays quiet below the floor, however lopsided the project", () => {
  /*
    A folder can be 100% of a tiny project's bytes without the upload being a
    problem, and asking then is noise. `few-huge-files` and `binary-media` in
    the soak suite are exactly this shape.
  */
  const files = [
    ...Array.from({ length: 40 }, (_, at) => file(`media/clip-${at}.mp4`, 9 * 1024 * 1024)),
    ...Array.from({ length: 6 }, (_, at) => file(`src/a${at}.ts`, 2048)),
  ];
  assert.deepEqual(suggestBulkDirectories(files), []);
});

test("a huge folder of source is still somebody's work", () => {
  /* The source guard applies to both shapes, not only to the count one. */
  const files = [
    ...Array.from({ length: 13 }, (_, at) => file(`engine/gen-${at}.cpp`, GB)),
    ...Array.from({ length: 40 }, (_, at) => file(`docs/d${at}.md`, 2048)),
  ];
  assert.deepEqual(suggestBulkDirectories(files), []);
});
