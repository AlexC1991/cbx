# cbx-engine

CBX's native byte engine, in Rust. It does the heavy byte work (reading, hashing, cutting, compressing, storing, deltas) for the `cbx` command. Its output is identical to the TypeScript CBX's, so everything already saved keeps working, both in local histories and on CodeRook.

## The compatibility contract

Nothing the service or an older `cbx` reads may change. That means these stay byte-for-byte the same, and the cross-tests check each one:

| What | Where it is defined | Why it cannot change |
| --- | --- | --- |
| Object names: SHA-256 of the raw bytes | `core/cbx.ts`, `local/store.ts` | Every stored object on CodeRook and in every history is filed under it |
| Chunk cut points for each profile id (GEAR table, masks, sizes, "hash every byte, test past the minimum") | `shared/chunking.ts` | A chunk cut one byte differently gets a different name, so nothing already uploaded would be reused |
| Which profile a file of a given size uses (none below 8 MiB, medium, large, huge, micro when the service offers `microchunk-map-v1`) | `profileForFileSize`, `microchunkProfileForFileSize` | The same reason |
| Chunk frames: `CHNK`, 88-byte header, codec 0/1, both digests | `chunkFrame` / `openChunkFrame` | Bundles and the local store keep every object this way |
| The "cbx-local 1" store: `objects/ab/…` loose frames, `packs/<sha256>.pack` with a JSON `.idx` | `local/store.ts` | Histories made by either implementation must open in the other |
| What goes over the wire: whole objects, gzip or identity, plus the existing CRS/CRP transport deltas | `core/upload.ts`, `shared/delta.ts` | The service's API and what it stores are unchanged |

Allowed to differ, because every reader checks digests rather than bytes:

- **zstd output inside a frame.** A different zstd build may compress the same bytes differently. The stored bytes and their digest change, but the object's name does not, and both readers check both digests.
- **Pack ids.** A pack is named by the SHA-256 of its bytes, so different zstd output gives a different pack name. Readers find objects through the index, not the pack name.

Where CBX v2 adds new shapes (byte-level deltas between versions, solid blocks of small files, a binary index), they stay local to the machine. A history that holds any of them is marked with a new format line, and an older `cbx` already refuses a format it does not read, with "Update cbx". What goes to CodeRook is still whole objects named as before.

## What has been checked

`compat/cross.mjs` runs the TypeScript CBX and the engine on the same real folders and compares everything:

- every file over 8 MiB: chunk ends, chunk names and file digest;
- a sample of 1–8 MiB files cut with all five profiles;
- the whole folder stored by each into its own store: the same digest and chunk list for every file, and then each implementation reads back every object from the other's store;
- 20 random edits of real files per folder: the engine's deltas applied by the research prototype, and the reverse.

```
CBX_DIST=<cbx compiled with tsc> ENGINE=<release binary> PROTO_DELTA=<prototype delta.mjs> \
  node compat/cross.mjs <scratch dir> <folder>...
```

`compat/rules-cross.mjs` checks which files a save includes. For each folder it runs the folder's own rules, a sample of the built-in ignore templates, and rule sets generated from the folder's real names (negations, anchors, `**`, character classes, folder-only rules, escapes, stray spaces, CRLF). With `--plant <scratch>` it also puts random `.gitignore` files in random subfolders of a copy. The engine's list must equal `surveyFiles` file for file, and its order must equal the order `changedFiles` walks in, because that order decides what the 20,000-row cap keeps. A rule JavaScript cannot compile must make both refuse.

```
CBX_DIST=… ENGINE=… node compat/rules-cross.mjs [--templates N] [--fuzz N] [--plant <scratch>] <folder>...
```

The rules are ported exactly, quirks included: JavaScript's `trim`, `a/**b` also matching `a/xb`, and patterns matched over UTF-16 units, as JavaScript does without the `u` flag (so `?` matches half an emoji). The first pass that gathers nested `.gitignore` files runs in disk order, as the TypeScript one does, because a folder listed before its parent's `.gitignore` is judged without it.

`cargo test --release` covers the fast chunker against the plain loop (noise, long flat runs, every way of feeding a file in pieces), frames, deltas (single and multi-base fuzz, wrong bases refused) and several big files stored at once.

## Commands

Each command prints one JSON value; errors go to stderr with a non-zero exit.

```
cbx-engine cuts <file> [auto|<profile id>]       chunk ends (as chunkBoundaries) and names
cbx-engine digest <file>...                      SHA-256 and size
cbx-engine store <objects dir> <root>            stdin [{"path","size"}] -> stored files
cbx-engine check <objects dir>                   stdin [names] -> every object read back and checked
cbx-engine get <objects dir> <name> <out>        one object's bytes, checked
cbx-engine put <objects dir> <file> [loose]      one object in
cbx-engine delta-make <out> <target> <base>...   a version 4 delta
cbx-engine delta-apply <out> <delta> <base>...   the target again
cbx-engine quick-status [root]                   status without Node: clean, what changed, or unknown
cbx-engine version
```

## As the `cbx` command

A standalone CBX installs this program as `cbx` itself (a copy or a link
named `cbx`, or `cbx.exe` on Windows). Run under that name it is the command
line's front: `cbx status` is answered here when the history lets it be, and
every other command, and any status it cannot vouch for, is handed to the
JavaScript command line:

```
CBX_CLI   the command line's bin.js (default: cli/dist/cli/src/bin.js, or bin.js, beside this program)
CBX_NODE  the Node to run it with (default: node on the PATH)
```

Status is answered here only for a cbx-local 2 history whose index says, in
the stamp the last status or save left, that the folder was exactly the line's
newest save and that the index held every file. A walk of the folder then
names what changed: a file whose size or time moved is read and compared with
its digest, a file the index lacks is new, an entry with no file is gone.
Anything else (a v1 history, a Git repository, no `.gitignore`, a merge
waiting, a line moved since the stamp, more than 256 files to read) is left to
the full status, so the answer is always the one it would give, byte for byte.

On the same 8,525-file folder, a quiet status took 24 ms this way, 96 ms
through npm's launcher and Node, and 52 ms for `git status`; with one file
edited, 31 ms, 123 ms and 56 ms. The npm package cannot install a program
like this as `cbx`: npm's launchers always start Node, and install scripts
are no longer run by default.

## Building

```
cargo build --release
```

Cross-builds for Linux and macOS use `cargo zigbuild`, with no Docker.
