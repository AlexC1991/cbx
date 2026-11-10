# The cbx-local 2 object store

Status, 10 November 2026: built in TypeScript (`cbx/src/local/store_v2.ts`, `store.ts`), used only for histories made with `CBX_LOCAL_FORMAT=2`. It becomes the default only once it beats Git on history size and status on the benchmark suite (speed runs and twenty-save histories of the same real folders, every save restored and checked).

First results, 20 realistic saves (`bench3.mjs`, every save restored exactly, damage refused): CMake 33.87 MB against Git 66.95 MB as it ships and 39.13 MB after `gc --aggressive`; JDK 121.85 MB against 150.24 and 127.93 MB; a 14,399-file engine 103.44 MB against 134.8 and 119.54 MB. Status, through the native front a standalone CBX installs as `cbx` (engine/src/quick.rs): quiet 47 ms on CMake, 36 ms on JDK and 81–86 ms on the engine, against Git's 57–68, 53–59 and 75–76 ms; with one file edited 47, 49–51 and 85 ms. Through npm, which always starts Node, 128–186 ms quiet. The engine's 14,399-file folder is the one place Git is still a few milliseconds ahead: listing its 1,304 folders takes about 30 ms however many threads do it.

As built, it differs from the design below in two ways: larger objects that compress are joined too, into 64 MiB blocks with a 64 MiB window (CMake's executables took 31.96 MB one by one and 23.89 MB together), and a local delta may be as large as the largest chunk any profile cuts (32 MiB), not the transport's 8 MiB. The index is searched in place, one binary search per pack, and decoded into one map only when a save or restore makes enough lookups to pay for it.

## What stays exactly the same

A v2 history holds **the same objects as a v1 history**, under the same names:

- a file under 8 MiB is one object, named by its SHA-256;
- a larger file is cut at the same points by the same profile, and each chunk is an object named by its SHA-256;
- trees and saves are the same JSON, so **save ids are identical** whether a history is kept in v1 or v2.

Only how an object is *kept on disk* changes. Reading any object from a v2 store gives exactly the bytes a v1 store would give, checked against the object's name before use. So everything built on objects is unchanged: `push` and `pull` send and receive the same objects, CodeRook stores the same things, and restores, diffs and merges work unchanged.

(The research prototype also cut big files into its own 1 MiB chunks. That would rename objects CodeRook already holds, so v2 does not do it. The deltas make chunk size matter much less: a changed 4 MiB chunk stored as a delta against the old one costs about what the edit costs.)

## What changes: three ways to keep an object

| Kind | Used for | Stored as |
| --- | --- | --- |
| **frame** | anything; everything in a v1 store | the v1 chunk frame (CHNK), loose or in a v1 pack, unchanged |
| **delta** | a changed file or chunk with an older object it resembles | copy/insert ops against 1–6 base objects (the version 4 delta in `src/delta.rs`), zstd when smaller |
| **solid** | new small objects saved together | concatenated with similar files (grouped by extension, then name), compressed as one 16 MiB block with zstd 9 and long-distance matching |

Bases for a delta:

- **under 8 MiB:** the object the same path had in the previous save; for a renamed or new file, the last object with the same name, then the same extension and similar size;
- **chunked files:** the previous version's chunks covering the same byte range (lined up by the nearest unchanged chunk), then, for what those cannot supply, old chunks found through a fingerprint index of the previous version.

A delta is kept only when it is clearly smaller than the object compressed whole (under half, and at least 96 bytes better). A delta may stand on at most 12 others; past that, the object is kept whole, so rebuilding never walks a long chain.

## Files

```
.cbx/format                "cbx-local 2"
.cbx/objects/ab/cdef…      v1 loose frames, still read
.cbx/objects/packs/*.pack  v1 packs with JSON .idx, still read
.cbx/objects/v2/<id>.pack  v2 packs: frames, deltas and solid blocks, append-only, written whole then renamed
.cbx/objects/v2/<id>.idx   binary index: name, kind, pack, offset, length, raw length, bases, chain depth
```

The binary index replaces JSON for v2 packs. It is sorted by name with a 256-entry fan-out table (the same idea as Git's pack index), so looking up one object reads a few kilobytes, not every index in the store.

## Compatibility

- **Reading:** a v2 store reads every v1 object as it always did. Upgrading changes nothing already written; new saves write v2 packs.
- **Older cbx:** it already refuses a history whose format line it does not know, with "Update cbx". So it can never misread a v2 history; it asks to be updated.
- **Back to v1:** `cbx` can write every object as a v1 frame again (the objects are the same, only stored differently), for anyone who needs an older cbx to read a history.
- **CodeRook and the desktop:** unchanged. They see objects, never local storage.

## How it is checked

- Every object read is rebuilt and checked against its SHA-256 before use, including every delta base.
- Cross-tests: the same folders saved by v1 and v2 must give identical save ids, and every object must read back byte-identical from both.
- The benchmark suite, unchanged, on the same real folders: speed, history size over 20 realistic saves (Git as it ships and after `gc --aggressive`), old saves restored byte for byte, one byte of damage, the 3.3 GB archive.
- The research prototype's tests carried over: 63 edit types × real files, 120 chained random versions, 700 random delta round trips.

## Status, the other gap

Status is mostly start-up time: Node starting, the CLI loading, and npm's launcher. The work itself is now 60–100 ms. To come close to Git, a plain `cbx status` has to be answered by a native program. The engine binary would answer it directly and hand everything else to Node. That needs npm's launcher to start a native binary, which is still to be tested on Windows, Linux and macOS.
