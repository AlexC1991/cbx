# CBX

CBX is the engine behind [CodeRook](https://coderook.com) version control: it
reads a project folder, decides what belongs in a save, splits and compresses
the files, and packs them into snapshots. It is built for the projects Git
struggles with (game projects, asset libraries, datasets and model weights) as
well as ordinary code.

Every save is a complete snapshot of the folder. Files are split into
content-defined chunks, so a chunk repeated across saves or across files is
stored once, and whatever can be compressed is.

## Status

This package is the engine the CodeRook desktop app and the `cbx` command
line use, and a standalone version control system in its own right. It got
here in four stages:

1. **Done:** the engine, extracted into this package under the Apache License 2.0.
2. **Done:** a local history. `cbx init` makes a `.cbx/` folder in the
   project, and `save`, `log`, `status`, `diff`, `restore` and `switch` work
   with no connection at all. `merge` combines lines, and `push` and `pull`
   use CodeRook as a remote.
3. **Done:** a written specification of the on-disk format
   ([spec/FORMAT.md](spec/FORMAT.md)) and the sync protocol
   ([spec/PROTOCOL.md](spec/PROTOCOL.md)), so anybody can build a compatible
   tool or server. The format's test vectors are checked against this code.
4. **Done:** published: the source at
   <https://github.com/AlexC1991/cbx>, and the packages `@coderook/cbx` and
   `@coderook/cli` on npm, all under the Apache License 2.0.

## A local history

```
cbx init
cbx save -m "First playable build"
cbx status
cbx diff
cbx switch -c new-movement
cbx merge new-movement
cbx log
cbx restore --from main~2
cbx push
cbx pull
```

What `.cbx/` holds:

| Path | What it is |
| --- | --- |
| `objects/ab/cdef…` | Every piece of every file, every tree and every save, named by the SHA-256 of its bytes and kept as a chunk frame (zstd when that saves at least 2%). Checked every time it is read. |
| `lines/<name>` | The newest save on each line of work |
| `state.json` | Which line the folder is on |
| `index.json` | The size and time of each file when it was last read, so unchanged files are not read again |
| `config.json` | The author name saves carry |
| `remote.json` | Which CodeRook project this history pushes to, and which local save each CodeRook save holds |

Small objects are kept together in packs (`objects/packs/`) rather than one
file each, because creating tens of thousands of small files is most of what a
first save costs on Windows.

## CodeRook as a remote

`cbx push` sends each save on the current line that CodeRook does not have,
oldest first, each as a CodeRook save of its own holding only what changed.
A save and a CodeRook version are recorded as the same only once CodeRook's
list of files matches the save's exactly. If CodeRook's line has moved on
since the last push, nothing is sent and you are told to pull first, as git
does.

`cbx pull` fetches the CodeRook saves this history does not have, reusing any
file contents it already holds, and moves the folder to the newest, touching
only files that differ. If this history also has saves CodeRook does not, the
two are merged, as git's pull merges; the merge is then pushed as one save.

## Merging

`cbx merge <line>` compares both sides with the save they last shared. A file
only one side changed is taken from that side; a text file both changed is
merged line by line; only what is left is a conflict. Text conflicts are
marked in the file the usual way (`<<<<<<<`, `=======`, `>>>>>>>`), binary
files and change-against-delete keep one whole copy and are named. Fix them
and `cbx save`, take a side with `cbx merge --mine` or `--theirs` (optionally
`--path <file>`), or call it off with `cbx merge --cancel`.

A file under 8 MB is one object. A larger one is cut where its content says
to, so an edit in the middle of a large asset stores the pieces around the
edit and reuses the rest. A save's id is the digest of the save itself, and
nothing in it depends on the machine, so the same files, message, author and
time give the same id anywhere.

`restore` and `switch` never overwrite an unsaved change without `--force`,
never touch a file the history has never held, and refuse any stored path that
would land outside the folder or inside `.git` or `.cbx`.

## What is in it

| Area | Modules |
| --- | --- |
| Reading a folder: what changed, what the ignore rules keep out | `core/worktree`, `core/rules` (gitignore-compatible), `core/ignore_templates`, `core/detect` |
| Chunking, compression and packing | `shared/chunking`, `core/compress`, `shared/compression_policy`, `core/solid`, `shared/delta` |
| The `.cbx` bundle: a whole project in one file | `core/cbx` |
| Keeping credentials out of a save | `core/secret_patterns`, `core/credentials` |
| Safe paths: nothing written outside the project, nothing into `.git` | `shared/safe_path` |
| Licence detection | `core/licences`, `core/licence_texts` (SPDX texts, CC0) |
| Talking to a CodeRook server: upload, download, lines of work | `core/upload`, `core/download`, `core/tracks`, `core/staging` and helpers |
| Text merges | `shared/merge_diff` |
| The local history: store, lines, saves, restore and switch | `local/store`, `local/repository`, `local/snapshot`, `local/history` |
| Merging lines | `local/merge`, `local/merge_text` |
| CodeRook as a remote: push and pull | `local/remote` |

The engine uses nothing outside Node's standard library.

## Using it

The `cbx` command line is the usual way in:

```
npm install -g @coderook/cli
```

The engine is also a library:

```
npm install @coderook/cbx
```

```js
const { init, save, log, merge } = require("@coderook/cbx");
const repository = await init("my-project");
await save(repository, { message: "First save" });
```

`@coderook/cbx/local/*`, `@coderook/cbx/core/*` and `@coderook/cbx/shared/*`
reach the individual modules listed above.

## Build and test

Node 20.11 or later.

```
npm install
npm test
```

`npm run build` compiles to `dist/`.

## What it sends, and to whom

Only what you ask it to. Scanning, rules, chunking and packing run entirely on
your machine. When you save to a CodeRook server, the upload reports how many
requests and bytes that save took, how long it ran, and peak memory
(`shared/telemetry`), to that same server and nowhere else. It is how a slow
save gets diagnosed. There is no other telemetry.

## Licence

Copyright 2026 ACCA Gaming Productions. Licensed under the Apache License,
Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

"CodeRook" is a name of ACCA Gaming Productions, and the licence grants no
right to use it for another product or service.

Source: <https://github.com/AlexC1991/cbx>. Security reports go to
security@coderook.com.
