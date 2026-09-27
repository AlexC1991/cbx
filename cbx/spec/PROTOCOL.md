# CodeRook sync protocol

**Protocol version:** 1, as `GET /v1/meta` reports it.
**Status:** describes the CodeRook API as of September 2026.

- **Additions.** New fields and routes can appear without a new protocol version. A client MUST ignore response fields it does not know.
- **Breaking changes** raise the protocol version.

This is how a CBX history, or any other client, reads from and writes to a CodeRook server. The storage format of a local history is in [FORMAT.md](FORMAT.md).

The words **MUST**, **SHOULD** and **MAY** are used as in RFC 2119. Anything marked *client policy* is what CBX does; a server does not require it.

---

## 1. Model

- **Repository.** A project, identified by a UUID.
- **Track.** A named line of versions in a repository. A track of `kind: "line"` is an ordinary branch. A track of `kind: "merge"` holds an upload the server could not merge cleanly, until someone decides what to do with it.
- **Version.** One save of the whole project:
  - It records every file, not a change.
  - Its `sequence` is numbered per track.
  - Its parents are listed first-parent-first.
- **Object.** Stored bytes, identified to the client by a UUID `objectId`.
  - A file is stored in one of three ways: whole as one object, as a slice of a solid pack, or as a list of chunk objects.
  - The server stores an object once per repository for each SHA-256 of its logical bytes.

## 2. Transport

### 2.1 Origin
- **Base.** The API origin is `https://api.coderook.com`.
- **Paths.** Every route below is under `/v1/` except `/health`.
- **Bodies.** JSON unless stated otherwise.

### 2.2 Authentication
Every `/v1/` route except `/v1/auth/*`, `/v1/public/*` and `/v1/meta` needs:

```
Authorization: Bearer <token>
```

- **Personal access tokens** start with `crk_`. They are created by the account holder:
  - on the website, or
  - with `POST /v1/account/tokens` and a body of `{name, expiresInDays: 1–365 | null, scopes}`.
- **Scopes.** A token without the `projects:write` scope may only use `GET`, `HEAD` and `OPTIONS`. Anything else gets 403 `token_read_only`. Every write step below needs write scope, including the read-like `POST …/stored`.
- **Missing or invalid token:** 401 `unauthorized`.

### 2.3 Identifying the client
A client SHOULD send a header naming itself:

```
x-coderook-client: <kind>/<version>          CodeRook's own clients: cli, desktop, web
x-coderook-client: tool/<name>/<version>     anything else
```

- **Name and version rules.** `<name>` is 1–64 characters: lower-case letters, digits, `.`, `_` and `-`, starting with a letter or a digit. `<version>` is semantic versioning (`1.2.3`, optionally followed by `-…` or `+…`).
- **When it matters.** The server may refuse a named capability to builds below a floor. Today the only such capability is `materialise`, used by the by-path file route (section 4.5):
  - a client that does not identify itself is refused it;
  - a `tool` client has no floor;
  - a refusal is `426 client_too_old`, with `{capability, minimumSupported, yourVersion, upgradeUrl}` in the error body.
- **`GET /v1/meta`** needs no sign-in. It returns `{protocolVersion, capabilities, upgradeUrl, you}`, where `you` is how the server read the header.

*Client policy:* CBX sends `cli/<version>` or `desktop/<version>`, plus `accept: application/json`.

### 2.4 Errors
Every error has this body:

```json
{"error":{"code":"…","message":"…","requestId":"…"}}
```

- **Acting on errors.** A client acts on `code` and the HTTP status, never on `message`.
- **Non-JSON bodies.** Failures at the network edge can return HTML, so a client MUST parse the body as JSON only when it starts with `{`.

Common codes:

| Status | Codes |
| --- | --- |
| 400 | `invalid_request`, `invalid_identifier`, `invalid_json` |
| 401 | `unauthorized` |
| 403 | `token_read_only` |
| 404 | `not_found` |
| 409 | `conflict` |
| 500 | `internal_error` |

### 2.5 Retries and deadlines
*Client policy, recommended:*

- **Attempts.** Up to 5, with backoff starting at 500 ms, doubling each time, jittered by ×0.5–1.5.
- **Retry:** any failure with no HTTP status (network error or timeout), 408, 5xx, and 429 unless the code is `upload_rate_exceeded`.
- **Do not retry:** any other 4xx, which is final.
- **Deadlines:**
  - 180 seconds for an ordinary request;
  - 15 minutes for an archive;
  - 8 seconds for `/health`.
- **Never repeat** a multipart `complete` (section 5.7).

## 3. Discovering the server

`GET /health` needs no authentication. It returns 200 when the server is ready and 503 otherwise:

```json
{"status":"ok","database":"ok","schemaVersion":"…","requiredSchemaVersion":"…",
 "objectStorage":"ok","environment":"production",
 "contentEncodings":["identity","gzip"],
 "features":["chunked-files","solid-packs","delta-transport","delta-transport-v2","delta-batch-v2"]}
```

| Feature | Meaning |
| --- | --- |
| `chunked-files` | Files of 8 MiB or more may be sent as chunk objects (section 5.6) |
| `solid-packs` | Small files may be sent together as a solid pack (section 5.5) |
| `delta-transport`, `delta-transport-v2`, `delta-batch-v2` | A changed small file may be sent as a patch against its previous version (section 5.8). Optional. |
| `microchunk-map-v1` | Chunk large files with the `fastcdc-v3-micro` profile (256 KiB / 1 MiB / 4 MiB) instead of the size-banded profiles |
| `repository-telemetry-v1` | The version-create response includes timing figures. Clients may ignore them. |

- **When discovery fails**, a client MUST assume no features and `identity` encoding only.
- **gzip** may be used only when `contentEncodings` lists it.

## 4. Reading

### 4.1 Tracks: `GET /v1/repositories/:id/tracks`

```json
{"tracks":[{"id":"…","name":"main","kind":"line","headVersionId":"…|null","protected":false,"requiredApprovals":0}]}
```

- **Members** see every track.
- **Visitors** see only lines. Each line's head is the newest version the owner made public, and lines with none are hidden.

### 4.2 Creating a track: `POST /v1/repositories/:id/tracks`

```json
{"name":"feature","fromVersionId":"…"}
```

- **`name`:** 1–80 characters, matching `^[A-Za-z0-9][A-Za-z0-9._/-]*$`. It cannot be `M-<digits>`, cannot end with `/`, and cannot contain `//`.
- **Starting point.** Without `fromVersionId` the line starts at the head of `fromTrack`, or of `main` if `fromTrack` is absent.
- **Returns** 201 `{track}`.
- **Errors:**

| Status | Code |
| --- | --- |
| 409 | `track_exists`, `nothing_to_branch_from` |
| 404 | `base_version_not_found`, `base_track_not_found` |

### 4.3 Versions: `GET /v1/repositories/:id/versions`
Returns every version on every line, newest first. Each row includes:

- `id`, `sequence`, `message`, `state` (`verified` or `held`), `createdAt`;
- `author: {id, displayName}`;
- `fileCount`, `sourceSize`, `storedSize`;
- `parentVersionIds`, first parent first;
- `visibility`.

Visitors see only named, public, verified versions:
- their `sequence` is the public numbering;
- parents are limited to versions the visitor can see.

### 4.4 A version's files: `GET /v1/repositories/:id/versions/:v/files`

```json
{"files":[{"path":"…","sha256":"…","sourceSize":0,"storedSize":0,"mediaType":"…","executable":false,
           "objectId":"…|null","pack":{"objectId":"…","offset":0,"length":0},
           "chunks":[{"objectId":"…","sha256":"…","sourceSize":0,"storedSize":0}],"sealed":true}]}
```

- **`sha256`** is the digest of the file's bytes as this caller will be served them.
- **Withheld locations.** `objectId`, `pack` and `chunks` are left out for visitors, and for callers who may not see credentials the owner published on purpose. Those callers MUST fetch the file by path (section 4.5).
- **`sealed: true`** means the stored copy has its credential values covered, and this caller is entitled to the real ones. The client MUST fetch the file by path; its pieces would not match `sha256`.
- **Held versions.** A version that is held for review is not listed; the route returns 404 `version_not_found`.

How to fetch each file, in order:

1. If `sealed`, fetch by path.
2. Else if `chunks`, fetch each piece and concatenate them.
3. Else if `pack`, fetch the pack object once and slice `[offset, offset + length)`.
4. Else if `objectId`, fetch that object.
5. Else fetch by path.

### 4.5 Objects: `GET /v1/repositories/:id/objects/:objectId`
- **Body.** The object's logical bytes, already decoded; for a solid pack, the whole decompressed stream.
- **Headers:**
  - `x-coderook-sha256`: the digest of those bytes;
  - `x-coderook-verification`;
  - `etag`.
- **Range requests** are honoured only for objects stored without compression.
- **Members only.** Anyone else gets 409 `object_by_path_only`.

**By path:** `GET /v1/repositories/:id/versions/:v/file?path=<url-encoded path>`
- Serves the file whatever its storage shape.
- Needs the `materialise` capability (section 2.3).
- A covered copy is sent without `x-coderook-sha256`; check it against the listing's digest.

**Whole version:** `GET /v1/repositories/:id/versions/:v/archive` returns the version as a ZIP.

### 4.6 Verifying what arrives
A client MUST verify, before writing anything to a user's folder:

- each chunk against its `sha256`;
- each pack slice against the file's `sha256`;
- each whole file against the listing's `sha256`;
- every path against the path rules in FORMAT.md section 6.2.

## 5. Writing a version

A version is written in two stages:

1. Make sure every object the version needs is stored.
2. Name them in one `POST …/versions`.

A file the base version already held unchanged is named by its existing storage and not sent again.

### 5.1 The base
- **Read it.** Read the base version's files (section 4.4) to know what the project already holds.
- **Deleting.** A version is a snapshot, so a file is deleted by leaving it out.

### 5.2 A new project: `POST /v1/repositories`

```json
{"slug":"my-game","displayName":"my-game","description":"","visibility":"private"}
```

- **`slug`:** up to 80 characters, matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- **Returns** 201 with the repository.

### 5.3 What is already stored
- **In bulk:** `POST /v1/repositories/:id/stored` with `{"sha256":[…]}`, 1–100,000 digests. The reply is `{"stored":{"<sha256>":{"objectId","storedSize"}}}`, listing only objects held and verified in this repository.
- **One digest:** `GET /v1/repositories/:id/stored?sha256=<hex>` returns `{stored: true, objectId, storedSize}` or `{stored: false}`.

### 5.4 Whole objects: `PUT /v1/repositories/:id/objects/:sha256`
- **Path.** `:sha256` is the digest of the **logical** bytes.
- **Body.** The stored bytes.
- **Required header:** `Content-Length`; without it the reply is 411 `content_length_required`.
- **Compressed bodies.** A gzip body adds `?encoding=gzip&logicalSize=<n>&storedSha256=<digest of the gzip bytes>`.
- **Chunks** add `kind=chunk&role=chunk`.
- **Size limit.** 95 MiB per request; above that the reply is 413 `multipart_required` (section 5.7).
- **Returns** 201 `{objectId, sha256, size, storedSize, encoding, verificationState}`.
- **Errors:**

| Status | Code |
| --- | --- |
| 409 | `stored_size_mismatch`, `object_size_conflict` |
| 413 | `storage_quota_exceeded` |
| 429 | `upload_rate_exceeded` (not retried) |

### 5.5 Small files together
Two ways to send small files in one request.

**Solid pack** (`solid-packs`): `POST /v1/repositories/:id/objects/pack` with an `application/octet-stream` body made of:

1. a 4-byte big-endian length;
2. the JSON manifest `{sha256, storedSha256, size, members:[{sha256, offset, length}]}`;
3. the gzip bytes of the member files concatenated.

- **Manifest fields.** `sha256` and `size` describe the decompressed stream, and `storedSha256` the gzip bytes.
- **Members** (2–4,096 of them) must tile the stream exactly, starting at 0.
- **Returns** 201 `{packObjectId, …}`.
- **Naming a member** in a version: `{pack: {objectId: packObjectId, offset, length}, sha256}`.

**Batch:** `POST /v1/repositories/:id/objects/batch` with a body made of:

1. a 4-byte big-endian length;
2. JSON `{objects:[{sha256, size, storedSize, mediaType, encoding, storedSha256?}]}`;
3. each object's stored bytes, concatenated in order.

- **Limits.** 1–512 objects, each at most 16 MiB stored.
- **Returns** 201 `{objects:[{sha256, objectId, size, storedSize}], failed:[{sha256, message}]}`.
- **Failures.** Send the failed ones again with section 5.4.

*Client policy:* CBX uses a pack for files of at most 1 MiB when gzip saves at least 5%, and a batch otherwise.

### 5.6 Large files as chunks (`chunked-files`)
- **Cutting.** Files of 8 MiB or more are cut with the content-defined chunking in FORMAT.md section 4. The profile is chosen by file size, or is `fastcdc-v3-micro` when the server advertises `microchunk-map-v1`.
- **Sending.** Each chunk is sent with section 5.4 using `kind=chunk&role=chunk`.
- **Naming the file** in a version: `{chunks: [{objectId, sourceSize, storedSize}], sha256: <whole-file digest>}`.

### 5.7 Very large objects without chunking: multipart

1. **Start:** `POST /v1/repositories/:id/uploads` with `{sha256, size, mediaType, kind: "chunk", repositoryRole: "chunk"}`. The reply includes `uploadSessionId` and `maximumPartBytes`.
2. **Parts:** `PUT /v1/uploads/:session/parts/:n`, numbered from 1, each at most 95 MiB.
3. **Finish:** `POST /v1/uploads/:session/complete` with `{}`. Do not repeat it.
4. **Give up:** `DELETE /v1/uploads/:session`.

- **Verification.** Objects made this way are `size_verified`, not `verified`, so section 5.3 does not report them as held.

### 5.8 Patches against the previous version (optional)
- **When it applies.** With `delta-transport-v2`, a client may send one changed file of at most 8 MiB as a patch against the base version's copy:
  1. ask for a signature: `POST …/objects/delta/signature`;
  2. send the patch: `POST …/objects/delta`.
- **Several files at once.** `delta-batch-v2` does the same for up to 64 files.
- **What the server stores.** It rebuilds the file, checks its digest, and stores it as an ordinary object.
- **Failure.** On any failure a client MUST fall back to section 5.4. The byte layout of these framings is defined in `cbx/src/shared/delta.ts`, and a client may skip this section entirely.

### 5.9 Upload quotes (optional)
- **Getting a quote.** `POST /v1/repositories/:id/uploads/preflight` with:
  - `sourceBytes`;
  - `excludedBytes`;
  - `objects: [{sha256, size, storedSize, storedSha256, mediaType, kind, repositoryRole, encoding}]`;
  - `track`.
- **What it gives back.** The server reserves storage against the account's allowance and returns `{quoteId, expiresAt, objects: {<sha256>: {objectId, storedSize, needsUpload}}, storage, allowance, …}`.
- **Using it.** Requests carrying `x-coderook-upload-quote: <quoteId>` are checked against the quote, and each renews its 30-minute expiry.
- **Cancelling.** `DELETE …/uploads/preflight/:quoteId`.
- **Without a quote**, each object is reserved as it is written.
- **A protected track** is refused here with 409 `track_protected`.

### 5.10 Naming the version: `POST /v1/repositories/:id/versions`

```json
{"message":"…","track":"main","baseVersionId":"…|null","ancestryMode":"required",
 "idempotencyKey":"…","sourceSize":0,"storedSize":0,
 "allowIgnored":false,"allowSecrets":false,"trackedByGit":[],
 "files":[{"path":"…","sourceSize":0,"storedSize":0,"mediaType":"…","executable":false,"objectId":"…"}]}
```

**Fields:**

- **`message`:** 1–240 characters after trimming.
- **`track`:** defaults to `main`. A line that does not exist is created.
- **`files`:** 1–100,000 entries; more than that is refused with 413 `version_too_many_files`.
  - Each entry names its bytes in exactly one way: `objectId`, or `pack` + `sha256`, or `chunks` + `sha256`.
  - Chunk sizes must add up to `sourceSize`.
  - A pack slice's `length` must equal `sourceSize`.
- **`baseVersionId`:** the version this upload was made from; `null` claims the line is empty.
  - With `ancestryMode: "required"`, a non-empty line with a `null` base is refused with 409 `workspace_base_required`.
  - A base that is not an ancestor of the line's head is refused with 409 `workspace_base_invalid`.
- **`expectedHeadVersionId`:** used only as the base when `baseVersionId` is absent.
- **`idempotencyKey`:** 8–120 characters. A key already used in this repository returns the earlier version with `repeated: true` instead of making a second.

Paths must be writable on every operating system. The server refuses:

- drive letters, and the characters `<>:"|?*` or control characters;
- names ending in a space or a dot, and device names;
- components over 255 characters or paths over 4,096;
- any `.git`, `git~N` or `.cbx` component;
- two paths that differ only in case or Unicode normalisation;
- a name used both as a file and as a folder.

What the server checks, in order:

1. **The version's own ignore rules.** The `.gitignore` files inside the version are applied to its paths. A path they exclude is refused with 422 `version_ignored_files`, unless:
   - the path is listed in `trackedByGit`, or
   - `allowIgnored` is true; the override is recorded in the project's audit log.
2. **Credentials** in files that differ from the latest version are refused with 422 `version_credentials`. The error names each path, line and kind, never the value.
   - With `allowSecrets`, the stored copy has its values covered, and the real values are sealed for people allowed to see them.
3. **A covered copy uploaded over real values** is refused with 409 `version_covered_copy`.
4. **Held for review.** In a project that holds pushes for review, a non-admin's version is saved as `state: "held"`, and the line does not move.
5. **Objects.** Every referenced object must belong to this repository and be verified; otherwise 409 `version_object_missing` or `version_size_mismatch`.
6. **A base that is not the line's head.** The server does **not** refuse it. It merges, path by path and then line by line:
   - if the merge is clean, the new version is published **with the other changes included**;
   - if not, the upload goes onto a new merge track, the line is left alone, and the reply carries `mergeTrack: {id, reference, conflicts: [{kind, path}]}`.
7. **Protected lines** refuse a direct publish with 409 `track_protected`.

**The reply** is 201 `{version, manifest, mergeTrack?, repeated?}`:

- `manifest.files[]` lists each file's `path` and `sha256`. It is `null` for a repeated attempt; read the files with section 4.4 instead.

**What a replicating client must do.** A client that must end up with exactly the files it sent, as a CBX push must, has two duties:

1. **Before sending**, compare the line's head with its base (section 4.1). If they differ, stop.
2. **After the reply**, compare the returned file list with what it sent.

Section 6 describes both.

## 6. How CBX pushes and pulls

The pairing between local saves and CodeRook versions is kept in `.cbx/remote.json` (FORMAT.md section 7.5). A pair means both hold exactly the same files.

**Push:**

1. **Find the line.** Read the line's head (section 4.1).
   - If the head is not paired with a local save, stop: CodeRook has saves this history does not. Pull first.
   - If the local tip is that save, there is nothing to push.
2. **Choose the saves.** Take the saves from the paired head up to the local tip, following any parents: the shortest route.
   - After a pull that merged, the route is the merge save alone, because its second parent is CodeRook's head.
   - If there is no route, both sides have moved on. Stop and pull.
   - A line that does not exist on CodeRook yet is created from the newest paired save (section 4.2).
3. **Send each save**, oldest first:
   - Write only the files that changed since the previous one into a scratch folder.
   - Upload them with `baseVersionId` set to the previous version, and `allowIgnored` set, because the save already applied the project's rules.
   - If the reply's `manifest.files` is not exactly the save's tree (same paths, same `sha256`), stop without pairing. The server merged in someone else's work.
   - Otherwise record the pair.
   - Each pair is recorded as it lands, so an interrupted push resumes where it stopped.

**Pull:**

1. **Walk back** from the line's head along first parents until a version is already paired. Import each newer version, oldest first, as a local save:
   - its message, `author.displayName` and `createdAt` are carried over;
   - its parent is the previous one;
   - only files whose contents the history does not already hold are fetched (section 4.4).
2. **Move the local line:**
   - **Fast-forward** if the local tip is an ancestor of the imported tip.
   - **Merge** (FORMAT.md section 8.2) if both have moved on. A clean merge is saved at once. Conflicts wait for the person.
   - **Nothing to move** if the local tip already includes the imported tip.

## 7. Integrity summary

| Value | Digest of |
| --- | --- |
| Object path segment, `files[].sha256`, `chunks[].sha256`, `x-coderook-sha256` | the logical (uncompressed) bytes |
| `storedSha256` | the bytes as sent and stored (the gzip stream when gzipped) |
| A solid pack's `sha256` / `storedSha256` | the decompressed stream / the gzip bytes |

- **What the server checks** is the stored bytes against `storedSha256` when an object is written.
- **What the client must check** is everything it downloads (section 4.6). A client MUST NOT rely on the server having checked logical digests.

## 8. Known limitations

These are true of the current server. A client should allow for them.

1. **Stale base.** `expectedHeadVersionId` is not compared with the line's head. A stale base is merged, not refused (section 5.10, item 6). Check the head before sending, and the reply after.
2. **No `merge_required`.** The server never returns `merge_required`. A diverged upload shows up as `mergeTrack` in a 201 reply.
3. **Repeated attempts.** A repeated idempotent attempt does not repeat `mergeTrack`, even if the first attempt was diverted.
4. **Multipart objects** stay `size_verified` and are not reported by section 5.3, so a later upload of the same bytes sends them again.
5. **Server-side merge identity.** The server compares files by stored object, so identical bytes stored whole on one side and chunked on the other count as a change.
6. **Unconfirmed shapes.** A storage digest mismatch on `PUT` has no dedicated error code, and the manifest shape under the server's experimental tree manifests (`manifest.format` other than `coderook-manifest-v1`) is not fixed. A client should rely only on `manifest.files[].path` and `sha256`, falling back to section 4.4 when they are absent.
