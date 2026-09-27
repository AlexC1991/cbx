# CBX local history format

**Version:** `cbx-local 1`
**Status:** stable for version 1. Anything that changes the meaning of existing bytes gets a new format line.
**Checked by:** `test/spec_vectors.test.ts`. That test reads the vectors in section 13 out of this file and checks them against the implementation and against an independent implementation of the rules as written here. If this document and the code disagree, the test fails.

This document describes what CBX keeps in a project's `.cbx/` folder:

- the objects that hold file contents;
- the trees and saves that describe a project at a moment;
- the small state files around them.

With it, another program can read a CBX history, write one CBX can read, and produce the same save ids CBX would for the same files.

The words **MUST**, **MUST NOT**, **SHOULD** and **MAY** are used as in RFC 2119. Anything marked *writer policy* is what CBX does and what a writer should do, but a reader MUST NOT depend on it.

How a history talks to a CodeRook server is in [PROTOCOL.md](PROTOCOL.md).

---

## 1. Conventions

- **Digest.** A digest is SHA-256, written as 64 lowercase hexadecimal characters.
- **Integers** in binary structures are unsigned little-endian.
- **Text** is UTF-8 without a byte order mark.
- **Canonical JSON** is defined in section 9. Every JSON object whose bytes are hashed MUST be written in canonical form.
- **Paths** inside a project are relative, use `/` as the only separator, and follow section 6.2.

## 2. Layout

```
<project>/
  .cbx/
    format              the text "cbx-local 1" and a newline
    objects/
      ab/cdef…          loose objects (section 3.3)
      packs/<id>.pack   packed objects (section 3.4)
      packs/<id>.idx
    lines/<name>        the newest save on each line (section 7.1)
    state.json          the line the folder is on (section 7.2)
    config.json         settings (section 7.3)
    index.json          a cache of what files looked like when last read (section 7.4)
    remote.json         pairing with a CodeRook project (section 7.5)
    merge.json          present only while a merge waits on conflicts (section 7.6)
    lock                present only while a command is writing (section 7.7)
```

A reader MUST check `format` first. If the file's content, with surrounding whitespace trimmed, is not exactly `cbx-local 1`, the reader MUST refuse to read the history.

`.cbx` is never part of the project:

- A tool that lists a project's files MUST skip any entry named `.cbx`, at any depth.
- A tool that writes a tree into a folder MUST refuse any path with a component named `.cbx` (section 6.2).

## 3. Objects

Everything a history stores is an object. That covers pieces of files, trees and saves. Objects never change once written.

### 3.1 Identity

An object's name is the digest of its **original bytes**: the bytes before any compression.

Two writers storing the same bytes produce the same name, whatever compression each chose.

### 3.2 Chunk frame

Each object is stored as one chunk frame, the same frame the CBX bundle format uses. It has an 88-byte header followed by the stored bytes:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic, ASCII `CHNK` |
| 4 | 1 | codec: `0` stored as is, `1` Zstandard |
| 5 | 3 | zero |
| 8 | 8 | raw size: length of the original bytes |
| 16 | 8 | stored size: length of the stored bytes that follow |
| 24 | 32 | raw digest (binary, not hex) |
| 56 | 32 | stored digest: SHA-256 of the stored bytes |
| 88 | stored size | stored bytes |

A reader MUST check each object it reads, in this order, and refuse it if any check fails:

1. The magic is `CHNK`.
2. The stored bytes are exactly `stored size` long.
3. They hash to the stored digest.
4. The codec is known.
5. The decoded bytes are `raw size` long.
6. The decoded bytes hash to the object's name.

With codec `1`, the stored bytes are one Zstandard frame (RFC 8878). Any valid frame is acceptable, so compressed bytes, and with them the frame, are **not** canonical. Only the name is.

*Writer policy:* CBX compresses at Zstandard level 3. It stores the bytes as is (codec `0`) unless compression saves at least 2%, that is, unless `compressed length ≤ raw length × 0.98`.

### 3.3 Loose objects

An object stored on its own lives at `objects/<first two hex digits>/<remaining 62>`.

*Writer policy:* write the frame to a temporary name in the same folder and rename it into place, so a half-written object never sits under a real name. An object that already exists is not written again.

### 3.4 Packs

Many small objects can share one file:

- `packs/<id>.pack` is chunk frames laid end to end, with nothing between them.
- `packs/<id>.idx` is a canonical JSON object. It maps each object name to `[offset, length]`: where that object's frame starts in the pack, and how long the frame is, header included.
- `<id>` is the digest of the whole `.pack` file.

Rules for readers and writers:

- A pack MUST be complete before its index exists. A writer writes and renames the pack first, then writes and renames the index.
- A reader MUST ignore a `.pack` with no matching `.idx`, because it is an interrupted write.
- The same object MAY appear in more than one pack, or both packed and loose. Any copy is valid.
- A reader looks an object up in the pack indexes and among the loose objects, in either order.

*Writer policy:*
- CBX packs objects of at most 256 KiB (original size) during a save, and starts a new pack at 32 MiB.
- Frames in a pack are ordered by object name.
- Trees and saves are always written loose.

## 4. Files as objects

A tree entry lists the objects a file's bytes are split into, in order. Concatenating their original bytes gives the file back.

For a history to give the same tree, and so the same save id, as CBX for the same files, a writer MUST split files exactly as follows:

- **Empty files** have no objects: `chunks` is `[]`.
- **Files under 8 MiB** (8,388,608 bytes) are one object: the whole file.
- **Files of 8 MiB or more** are cut with content-defined chunking, using the profile for their size:

| File size | Profile id | min | target | max | strict mask | loose mask |
| --- | --- | --- | --- | --- | --- | --- |
| 8 MiB to under 128 MiB | `fastcdc-v2-medium` | 262,144 | 1,048,576 | 4,194,304 | `0x1FFFFF` | `0x7FFFF` |
| 128 MiB to under 2 GiB | `fastcdc-v2-large` | 1,048,576 | 4,194,304 | 16,777,216 | `0x7FFFFF` | `0x1FFFFF` |
| 2 GiB and over | `fastcdc-v2-huge` | 2,097,152 | 8,388,608 | 33,554,432 | `0xFFFFFF` | `0x3FFFFF` |

These are the profiles CodeRook uploads use for files of those sizes, so a chunk stored locally and a chunk sent to CodeRook usually have the same name.

### 4.1 The gear table

A table of 256 unsigned 32-bit values, generated as follows:

```
seed = 0x9E3779B9
for i in 0..255:
    seed = (seed × 1103515245 + 12345) mod 2³²
    GEAR[i] = seed
```

### 4.2 Cut points

Cut points are computed over the whole file as follows:

```
cuts = []
from = 0
hash = 0
for at in 0 .. length−1:
    hash = ((hash << 1) + GEAR[byte[at]]) mod 2³²
    size = at − from + 1
    if size < min: continue
    mask = (size < target) ? strict : loose
    if size ≥ max or (hash AND mask) = 0:
        cuts.append(at + 1)
        from = at + 1
        hash = 0
if cuts is empty or the last cut ≠ length:
    cuts.append(length)
```

Each chunk runs from one cut to the next, starting at 0.

The hash keeps accumulating over the first `min` bytes of each chunk, even though no cut can happen there. It resets to zero only at a cut.

A streaming implementation reaches the same cuts by carrying forward the bytes after the last cut and scanning them again with `hash = 0`.

## 5. Why chunks carry names and not offsets

A tree lists object names rather than byte ranges. This means:

- a reader needs nothing but the objects to rebuild a file;
- an unchanged stretch of a large file costs nothing in the next save;
- identical files anywhere in any save share their objects.

## 6. Trees

### 6.1 Form

A tree is a canonical JSON object, stored as an object:

```
{"format":"cbx-tree","version":1,"files":[ENTRY, …]}
```

Each `ENTRY` has exactly these keys, in this order:

| Key | Type | Meaning |
| --- | --- | --- |
| `path` | string | Relative path (section 6.2) |
| `size` | integer | File length in bytes |
| `sha256` | digest | Digest of the whole file |
| `executable` | boolean | Whether the file is marked to run |
| `chunks` | array of digests | The file's objects, in order (section 4) |

Rules for entries:

- Entries MUST be sorted by `path`, comparing UTF-16 code units, as ECMAScript's `<` compares strings.
- A path MUST NOT appear twice.
- Only files appear. Folders exist only through the paths of the files inside them, so an empty folder is not recorded.

A tree's id is its object name: the digest of its canonical JSON.

### 6.2 Paths

A path MUST:

- be non-empty;
- use `/` between components and contain no `\`;
- contain no NUL;
- not start with `/` or a drive letter such as `C:`;
- have no empty component, and no component equal to `.` or `..`.

It MUST NOT contain a component that names version-control plumbing. Names are compared ignoring case, after dropping anything from the first `:` onwards and any trailing dots and spaces. The refused names are:

- `.git`;
- `git~` followed by digits (the Windows short name for `.git`);
- `.cbx`.

A tool writing a tree into a folder MUST check every path against these rules first. It MUST refuse the whole operation if any path fails, and MUST confirm each resolved path lies inside the folder before writing to it.

On Windows, a component containing `:` MUST also be refused, because it names an alternate data stream.

### 6.3 What goes into a save

*Writer policy, not required for reading.* CBX saves the files its ignore rules let through. Those rules:

- follow gitignore semantics;
- come from the project's `.gitignore` files and `.git/info/exclude`;
- fall back to CodeRook's starter rules when the project has no `.gitignore`.

Files that git tracks are kept even when a rule would exclude them. Symbolic links are skipped.

## 7. Saves

A save is a canonical JSON object, stored as an object. It has exactly these keys, in this order:

| Key | Type | Meaning |
| --- | --- | --- |
| `format` | `"cbx-save"` | |
| `version` | `1` | |
| `tree` | digest | The tree this save records |
| `parents` | array of digests | Empty for a first save; one for an ordinary save; two for a merge (below) |
| `line` | string | The line the save was made on |
| `message` | string | What changed |
| `author` | string | Who saved it |
| `created` | string | When, as ECMAScript's `Date.prototype.toISOString` writes it: `YYYY-MM-DDTHH:MM:SS.mmmZ`, in UTC |

In a merge save:

- the first parent is the save the line was on;
- the second is the save that was merged in.

A save's id is its object name.

Nothing in a save depends on the machine it was made on. The same tree, parents, line, message, author and time give the same id anywhere.

### 7.1 Lines

- **Tip file.** `lines/<name>` holds the id of the newest save on that line, followed by a newline.
- **When the file appears.** A line with nothing saved yet has no file.
- **Updating a tip.** A writer MUST update a tip by writing a temporary file and renaming it over the old one.

A line name MUST:

- be 1 to 100 characters from `A–Z a–z 0–9 . _ -`;
- start with a letter or a digit;
- not end with `.` or contain `..`;
- not end with `.partial`;
- not be a name Windows reserves (`con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`), in any case, alone or followed by a dot.

When a save is named on a command line:

- `<line>~N` means N saves back along first parents, and a bare `~` means one;
- four or more leading hex digits name a save by the start of its id, and are refused when more than one save matches.

### 7.2 state.json

The folder's current line:

```json
{"line":"main"}
```

### 7.3 config.json

Settings for this history. The only one defined is `author`, the name new saves carry. It is optional.

*Writer policy:* when `author` is absent, CBX uses the `CBX_AUTHOR` environment variable, then the operating system account name.

### 7.4 index.json

This file is a cache and a reader MAY ignore it. It maps each path to what the file looked like the last time it was read:

```json
{"src/a.txt":{"size":12,"mtimeMs":1790000000000,"sha256":"…","chunks":["…"]}}
```

- **When it is trusted.** A file whose size and modification time match its entry is assumed unchanged and is not read again.
- **The racy window.** A file modified within 2 seconds of being read is not recorded. Such a file could change again without its time moving, as git's "racily clean" files can.
- **Chunks.** `chunks` is empty when the file was hashed without being stored. A save stores any such file again rather than trusting the entry.

### 7.5 remote.json

Pairs this history with a CodeRook project (see [PROTOCOL.md](PROTOCOL.md)):

```json
{"repositoryId":"<uuid>","pairs":{"<save id>":"<CodeRook version id>"}}
```

A pair records that a local save and a CodeRook version hold exactly the same files, meaning the same paths with the same digests. A pair MUST NOT be recorded otherwise.

### 7.6 merge.json

Present only while a merge waits on conflicts:

```json
{"format":"cbx-merge","version":1,"theirs":"<save id>","base":"<save id>|null",
 "message":"…","touched":["path",…],"conflicts":[{"path":"…","kind":"text|binary|deleted-here|deleted-there"}]}
```

- **Finishing.** The next save becomes the merge save, with parents `[current tip, theirs]`, and the file is then removed.
- **Cancelling.** Cancelling puts every path in `touched` back as the current tip has it, then removes the file.

### 7.7 lock

A command that writes creates `lock` exclusively and removes it when done. A second writer finding it MUST NOT proceed.

A lock left behind by a crash is not removed automatically. A person removes it.

## 8. Operations

These are the guarantees CBX gives. A compatible tool SHOULD give the same ones.

### 8.1 Restore and switch

- **Unsaved work.** An unsaved change is a file that differs from the current tip. Restore and switch never overwrite or delete one without an explicit force.
- **Files a restore or switch leaves alone:**
  - files the history has never held;
  - on a switch, files both lines hold identically. Unsaved edits to those carry over to the new line.
- **Hidden files.** A file excluded by the current ignore rules, but present in the target, is checked on disk before being overwritten.
- **How writes land.** Files are written to a temporary name and renamed into place, or written directly when nothing is at that path yet.

### 8.2 Merge

A merge compares each path's entry in three places: `base` (the nearest common ancestor, found through all parents), `ours` (the current tip) and `theirs`.

Two entries are the same when both are absent, or when both have the same `sha256` and `executable`. Each path is decided as follows:

| Case | Result |
| --- | --- |
| `ours` = `theirs` | `ours` |
| `base` = `ours` | `theirs`, including its absence |
| `base` = `theirs` | `ours` |
| Only the execute bit differs, content the same | the content, with the side that changed the bit |
| One side changed the file, the other deleted it | the changed file; conflict `deleted-here` or `deleted-there` |
| A side is binary (a NUL in its first 8,192 bytes) or larger than 4 MiB | `ours`; conflict `binary` |
| Otherwise | the three-way text merge below; conflict `text` if any region conflicts |

The text merge works line by line, and each line keeps its own ending:

1. Match base against ours, and base against theirs, by longest common subsequence.
2. Walk the base. A base line both sides kept is output as is.
3. Between two such lines, compare the stretch of base with each side's stretch:
   - if ours equals the base, output theirs;
   - if theirs equals the base, output ours;
   - if ours equals theirs, output ours;
   - otherwise output a conflict:

```
<<<<<<< <our label>
…our lines…
=======
…their lines…
>>>>>>> <their label>
```

In a conflict block:

- each marker line ends with CRLF if our file uses CRLF, and LF otherwise;
- a side whose last line has no newline gets one, so a marker never joins onto it.

When nothing conflicts, the merge is saved at once. Otherwise the result is written to the folder and waits in `merge.json` (section 7.6).

## 9. Canonical JSON

Canonical JSON is the output of ECMAScript's `JSON.stringify` with no spacing arguments, applied to objects whose keys are in the order this document lists:

- no whitespace between tokens;
- strings in double quotes, escaping `"` and `\`;
- control characters U+0000 to U+001F written as `\b \f \n \r \t`, or otherwise as `\u00XX` with lowercase hex;
- lone surrogates escaped as `\uDXXX` with lowercase hex;
- every other character written as itself, in UTF-8;
- integers in decimal, with no sign for zero or positive values and no exponent;
- `true`, `false` and `null` as themselves.

## 10. Bundles

The single-file `.cbx` bundle (a whole project in one file, used by `cbx bundle`) predates the local history and shares its chunk frame (section 3.2). Its layout:

| Record | Layout |
| --- | --- |
| Header | `CBX1`, u16 format version, u16 flags, 16-byte bundle id (24 bytes) |
| Chunk | one chunk frame (section 3.2) |
| Manifest | `MANF`, u64 raw length, u64 stored length, 32-byte raw digest, then the manifest JSON, Zstandard-compressed |
| Footer | `CBXF`, u64 manifest record offset, u64 manifest record length, 32-byte manifest raw digest (52 bytes) |

A reader finds the footer at the end, then the manifest, then each file's chunks through the manifest's chunk table. Format versions 1 and 2 (2 adds solid packs) are readable.

## 11. Compatibility

- **Format line.** A change to anything a reader must understand gets a new format line (`cbx-local 2`).
- **Tree and save versions.** Trees and saves carry their own `version`. A reader MUST refuse a version it does not know.
- **Unknown state files.** A reader MUST ignore files it does not recognise in `.cbx/` other than those named here. A writer MUST NOT create new files there whose absence would change what the history means.

## 12. Security notes

- **Integrity.** Every object is verified when read (section 3.2), so a damaged or substituted object is found before a byte of it reaches the folder.
- **Paths.** Path rules (section 6.2) are enforced by the writer of the folder. A tree's paths are never trusted merely because a server or another tool accepted them.
- **Locks.** A lock is advisory. It stops two CBX commands from moving the same line at once. It does not stop another program from writing to `.cbx/`.

## 13. Test vectors

Each block below is read by `test/spec_vectors.test.ts`.

A chunk frame for the six bytes `hello\n`. Compression cannot save 2% on six bytes, so the codec is 0:

```json cbx-vector=chunk-frame
{
  "raw_hex": "68656c6c6f0a",
  "name": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  "frame_hex": "43484e4b00000000060000000000000006000000000000005891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be035891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be0368656c6c6f0a"
}
```

The gear table's first four entries and its last:

```json cbx-vector=gear
{ "first": ["62cb61fe", "50e84d5f", "30f613ac", "b5ccf875"], "last": "8e9830b9" }
```

Profile selection by file size:

```json cbx-vector=profiles
{
  "sizes": [0, 8388607, 8388608, 134217727, 134217728, 2147483647, 2147483648],
  "ids": [null, null, "fastcdc-v2-medium", "fastcdc-v2-medium", "fastcdc-v2-large", "fastcdc-v2-large", "fastcdc-v2-huge"]
}
```

Cut points for 20 MiB of generated bytes. The generator is `x = 1`, then for each byte `x = (x × 1103515245 + 12345) mod 2³²` and the byte is `x >> 24`:

```json cbx-vector=chunking
{
  "length": 20971520,
  "sha256": "3ee6ac1e5438e04eb5a81da659df73f7bf73b623e81023555ad09833a338a7c9",
  "fastcdc-v2-medium": [1313115, 1676525, 2786806, 3904857, 4992487, 6205267, 7169545, 8297268, 9410713, 10635606, 11048093, 12133009, 13348617, 15344845, 15970290, 16737442, 17216935, 18281118, 20646777, 20971520],
  "fastcdc-v2-huge": [2786806, 16112751, 20971520]
}
```

A tree holding `README.md` (`hello\n`) and an empty `src/empty.txt`:

```json cbx-vector=tree
{
  "json": "{\"format\":\"cbx-tree\",\"version\":1,\"files\":[{\"path\":\"README.md\",\"size\":6,\"sha256\":\"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\",\"executable\":false,\"chunks\":[\"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\"]},{\"path\":\"src/empty.txt\",\"size\":0,\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"executable\":false,\"chunks\":[]}]}",
  "id": "78c35cee6e6b19b088d3f96d117c7379ef896e643a9d9ea28c1fd18d21353eb2"
}
```

The first save of that tree:

```json cbx-vector=save
{
  "record": { "tree": "78c35cee6e6b19b088d3f96d117c7379ef896e643a9d9ea28c1fd18d21353eb2", "parents": [], "line": "main", "message": "First save", "author": "Ada", "created": "2026-09-27T00:00:00.000Z" },
  "id": "d055b0a66d2c5c5ae406fe46bf1a51d4847bc6b5e7c8efc781040a234d5c8ace"
}
```

A pack holding that one object:

```json cbx-vector=pack
{
  "id": "17d43d2b74d140b8fc52c3e54dc2935507976a290cccf9bb3d7d31d41ff7f05a",
  "idx": "{\"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\":[0,94]}"
}
```

A three-way text merge: two edits to different lines combine, and two edits to the same line are marked as a conflict:

```json cbx-vector=merge
{
  "base": "a\nb\nc\n",
  "ours": "A\nb\nc\n",
  "theirs": "a\nb\nC\n",
  "result": "A\nb\nC\n",
  "conflict_base": "x = 1\n",
  "conflict_ours": "x = 2\n",
  "conflict_theirs": "x = 3\n",
  "conflict_result": "<<<<<<< ours\nx = 2\n=======\nx = 3\n>>>>>>> theirs\n"
}
```
