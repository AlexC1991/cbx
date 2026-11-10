# CBX

CBX is version control for projects of any size: game projects, asset
libraries, datasets and model weights, as well as ordinary code. It keeps a
full history in your project folder and works entirely offline.
[CodeRook](https://coderook.com) is one place you can push that history, and
the protocol for doing so is published here too.

```bash
npm install -g @coderook/cli

cbx init
cbx save -m "First playable build"
cbx switch -c new-movement
cbx save -m "Try a double jump"
cbx switch main
cbx merge new-movement
cbx log
```

## What it does

- **Every save is a whole snapshot.** Files are split into content-defined
  pieces, so a piece repeated across saves or files is stored once. An edit in
  the middle of a 2 GB asset stores the pieces around the edit, not the file.
- **Compression where it pays.** Every stored piece is compressed when that
  saves at least 2%, and checked against its SHA-256 every time it is read.
- **Small files are packed**, so a project of tens of thousands of little
  files does not become tens of thousands of little files again.
- **Lines of work and real merges.** A three-way merge takes whatever only
  one side changed, merges text files line by line, and marks only what is
  left. Binary files are never mangled: one side is kept and named.
- **It does not lose work.** Restoring, switching, merging and pulling refuse
  to overwrite a change you have not saved, and never touch a file the
  history has never held.
- **Push and pull.** `cbx push` sends each save to CodeRook as a save of its
  own; `cbx pull` brings saves back and merges when both sides moved on.

## Commands

| | |
| --- | --- |
| `cbx init` | Start a history in this folder (`.cbx/`) |
| `cbx save -m "…"` | Record the folder as it is |
| `cbx status`, `cbx diff` | What changed since the last save |
| `cbx log` | The saves on this line |
| `cbx switch [-c] <line>` | Move to another line, or start one |
| `cbx merge <line>` | Bring another line's work into this one |
| `cbx restore [paths] --from <save>` | Put files back the way a save had them |
| `cbx push`, `cbx pull` | Sync with CodeRook |

`cbx help <command>` explains each one. The same binary also carries the
CodeRook account commands (`submit`, `get`, `clone`, `projects`, …); a folder
without a `.cbx/` history behaves exactly as it always has.

## Specifications

- [spec/FORMAT.md](cbx/spec/FORMAT.md): everything in `.cbx/`, byte for
  byte, with test vectors. Another program can read and write the same
  histories and arrive at the same save ids.
- [spec/PROTOCOL.md](cbx/spec/PROTOCOL.md): how a client pushes to and
  pulls from a CodeRook server.

The format's test vectors are read out of the document by
`cbx/test/spec_vectors.test.ts` and checked against the code, so the two
cannot drift apart unnoticed.

## In this repository

| Folder | What it is |
| --- | --- |
| [`cbx/`](cbx) | The engine: storage, chunking, the local history, merging, push and pull. Node's standard library only. |
| [`cbx/engine/`](cbx/engine) | The native byte engine (Rust): the same objects, faster, and the native `cbx` described below. |
| [`cli/`](cli) | The `cbx` command line, published as `@coderook/cli`. |

## Build and test

Node 22.15 or later (it uses `zlib`'s zstd, added in 22.15 and 23.8).

```bash
cd cbx && npm ci && npm test
cd ../cli && npm ci && npm test
```

## A native `cbx`

Installed from npm, every `cbx` starts Node first: npm's launchers always do.
Built from this repository, the engine can be the `cbx` command itself. It
answers `cbx status` on its own when the history lets it (no Node at all) and
hands every other command to the command line.

```bash
cd cbx && npm ci && npm run build
cd ../cli && npm ci && npm run build
cd ../cbx/engine && cargo build --release
# Put the engine at the top of this checkout under the name cbx, and that folder on your PATH:
cp target/release/cbx-engine ../../cbx        # Windows: copy target\release\cbx-engine.exe ..\..\cbx.exe
```

Next to it, `cli/dist/cli/src/bin.js` is found on its own; elsewhere, set
`CBX_CLI` to that file (and `CBX_NODE` if Node is not on the PATH). The status
it answers is the one the full command line prints, byte for byte, and it
answers only where it can vouch for that: see
[cbx/engine/README.md](cbx/engine/README.md#as-the-cbx-command). On an
8,525-file folder a quiet status took 47 ms this way, against 57–68 ms for
`git status`, and 47 ms with a file edited, against 57–70 ms.

### The cbx-local 2 history (preview)

`CBX_LOCAL_FORMAT=2 cbx init` makes a history that keeps the same objects
and save ids in solid blocks and deltas: over 20 saves of three real folders
it came to 13–14% less than Git after `git gc --aggressive` on two of them
and 5% less on the third. It is a preview, and is not the default yet. An
older cbx refuses such a history and asks to be updated. The design is in
[cbx/engine/V2-STORE.md](cbx/engine/V2-STORE.md). The native status above
answers only in these histories.

## Licence

Copyright 2026 ACCA Gaming Productions. Licensed under the Apache License,
Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

"CodeRook" is a name of ACCA Gaming Productions. The licence covers this code,
not the name, and not the CodeRook service.
