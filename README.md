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
| [`cli/`](cli) | The `cbx` command line, published as `@coderook/cli`. |

## Build and test

Node 20.11 or later.

```bash
cd cbx && npm ci && npm test
cd ../cli && npm ci && npm test
```

## Licence

Copyright 2026 ACCA Gaming Productions. Licensed under the Apache License,
Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

"CodeRook" is a name of ACCA Gaming Productions. The licence covers this code,
not the name, and not the CodeRook service.
