---
name: coderook
description: Save, browse and restore versions of a project on CodeRook — a version host where every version is a complete snapshot and there is no git to learn. Use when asked to save or submit work to CodeRook, check what has changed, look at a project's versions or files, fetch a project, start or switch a line of work, or resolve a save that landed at the same time as somebody else's.
allowed-tools: Bash Read
---

# CodeRook

CodeRook stores whole snapshots of a folder. A version names every file the
project had at that moment, so restoring one never depends on the versions
around it, and there is no staging area, no branches to rebase and no history
to rewrite.

Everything here is the `coderook` command line. Run it with Bash.

## Before anything else

`cbx whoami` says who this machine is signed in as. If it refuses, the
person needs to run `cbx sign-in` themselves — it takes a personal access
token, so do not attempt it on their behalf.

If the command is not found at all, this machine has the skill but not the
command line. Either install it once with
`npm install --global @coderook/cli`, or put `npx -y @coderook/cli` where
`coderook` appears below — the commands are identical, npx is just slower
to start.

## Reading

```bash
cbx status               # what has changed in this folder since its last version
cbx projects             # every project on the account
cbx versions [project]   # what has been saved, newest first
cbx tracks [project]     # the lines a project has, and any waiting on a decision
```

`status` is the one to reach for when somebody asks what is uncommitted, what
changed, or whether anything needs saving. It reads the folder and changes
nothing.

## Saving

```bash
cbx submit -m "What changed, in a sentence"
```

Send only what changed; the version still names every file. Write the message
yourself from the actual diff rather than asking for one — a message like
"update" helps nobody reading the history later.

**Ask before running this.** Saving is the one thing here that leaves a mark on
somebody's account, and a version saved by mistake is a version they have to
explain. Propose it, say what it would send, and let them agree.

`cbx submit -n` shows exactly what would be sent without sending it. Use
that freely; it is safe and it is the honest way to answer "what would this
upload?".

## Fetching

```bash
cbx get                  # bring this folder up to date
cbx clone <project> [dir]  # fetch a project into a new folder
```

`get` protects local edits by default. `cbx get --replace` discards them
to make an exact copy — only run it when the person has said so in those terms.

## Lines of work

A project can have more than one line, so two people can save without one
landing on top of the other.

```bash
cbx track                 # which line this folder saves to
cbx track spike --new     # start a line and switch to it
cbx track main            # switch back
cbx submit --track spike -m "…"
```

Switching says where the next save goes and nothing else — no files move.
Run `cbx get` afterwards to bring that line's files in.

## A history on this machine

A folder with a `.cbx/` folder in it keeps its own history, and there
`status`, `diff`, `log`, `switch`, `merge`, `push` and `pull` work on that
history instead of the account. Check with `cbx status`: it names the line and
the last local save.

```bash
cbx init                       # start one (only when asked to)
cbx save -m "…"                # record the folder as it is
cbx log                        # saves on this line
cbx switch -c spike            # start a line here; no files change
cbx merge spike                # bring that line's work in
cbx restore path --from main~1 # put a file back from an earlier save
cbx push                       # send new saves to CodeRook
cbx pull                       # bring CodeRook's saves in, merging if both moved
```

A merge that stops on conflicts leaves markers in the files and waits. Show
the person the conflicts (`cbx status`) and let them decide; `cbx save`
finishes the merge once the markers are gone. Do not pass `--force` to
`restore`, `switch`, `save` or `pull` unless the person has said to throw away
the changes it names, and do not run `cbx merge --cancel` unless they asked.

## Versions, and going back

Every save is a commit. A commit becomes a *version* — the thing the public
side of a project offers, and the thing a collaborator pulls — only when
somebody promotes it.

```bash
cbx promote                    # pick from the last ten and name one
cbx mark 41 --pin              # pin, hide, rename or label one save
cbx labels add shipped green   # the labels a project can wear
cbx undo                       # put the project back on the save before this one
```

`undo` moves where the project stands. Nothing is deleted and nothing is
renumbered — the saves passed over stay in the history, and the next save
carries on from wherever it now stands. It is the answer to "I pushed the
wrong thing"; hiding a version stops strangers reading it but leaves the
project standing on it, so the next person to pull still lands on the mistake.

**Ask before `undo`, `promote` and `take-down`.** They change what other
people see. `cbx versions` first, so the person can say which save they mean.

## Who can reach a project

```bash
cbx visibility                 # what it is now: private, unlisted or public
cbx visibility public --yes    # list it on the owner's profile
cbx visibility private         # back to the people invited
```

**Never make a project public or unlisted unless the person has asked for
exactly that.** `--yes` skips the question the command would otherwise ask
them, so only pass it once they have answered it. Going private is always safe.

## Serving a project as a website

```bash
cbx pages                  # is the site on, its address, what it serves
cbx pages auto             # find the build in what was published, and offer to serve it
cbx pages on --folder dist # serve a folder of the published version
cbx pages off              # stop serving it
```

**Never turn Pages on (`auto` or `on`) unless the person has asked for their
project to be served as a site.** It runs their code in strangers' browsers
under the project's name. Pass `--yes` only once they have said yes. Only
published versions are served and the project must be public. When `auto`
finds a build left out by the ignore rules it offers a `.gitignore` line and
lists the next steps; it never saves or publishes — ask before doing those.
Turning Pages off is always safe.

## When two saves collide

If somebody saved while this folder was behind, the second save becomes a merge
waiting on a decision rather than overwriting anything.

```bash
cbx merges                # this folder's saves waiting on a decision
cbx merge <ref>           # look at one, and decide
```

Read the conflict out to the person and let them choose. Do not pick a side for
them: the whole reason it stopped is that the service could not tell which copy
was wanted.

## What is worth leaving out

```bash
cbx ignore --suggest          # dependency directories, build output, virtual environments
cbx ignore --suggest --apply  # add the confident ones to .gitignore
```

Rules live in the project's own `.gitignore`, so CodeRook, git and the website
all read one file.

## Bundles

```bash
cbx bundle . project.cbx   # the whole project, every version, as one file
cbx inspect project.cbx    # what is inside, without unpacking
cbx unbundle project.cbx ./restored
```

## Reading a public project without signing in

Public projects can be read by anything, with no token, from
`https://api.coderook.com/v1/public`. There is no need to read the command
line's source to find these — this is the whole of it:

```text
GET /projects?q=                                  public projects, newest first
GET /projects/{owner}/{slug}                      one project
GET /projects/{owner}/{slug}/versions             the versions it offers
GET /projects/{owner}/{slug}/releases/latest      newest release and its files
GET /projects/{owner}/{slug}/updates/latest.yml   electron-updater feed
GET /projects/{owner}/{slug}/versions/{v}/files         every file, with digests
GET /projects/{owner}/{slug}/versions/{v}/file?path=    one file
GET /projects/{owner}/{slug}/versions/{v}/archive       the version as a zip
GET /projects/{owner}/{slug}/versions/{v}/attachments   files attached to it
GET /projects/{owner}/{slug}/versions/{v}/attachments/{id}   download one
```

`{v}` is a version id or `latest`. A private project answers 404, exactly as
if it did not exist.

### An app that updates itself from CodeRook

Release a version named like a version number and attach the installer:

```bash
cbx release 1.4.0
cbx attach ./dist/MyApp-Setup-1.4.0.exe
```

An Electron app then needs nothing custom — electron-builder's generic
provider pointed at the feed:

```json
"publish": [{ "provider": "generic",
  "url": "https://api.coderook.com/v1/public/projects/OWNER/SLUG/updates" }]
```

The feed serves `latest.yml`, `latest-mac.yml` and `latest-linux.yml` with
each file's size and SHA-512, and redirects file names to their downloads.
Anything else can read `releases/latest` as JSON: version, notes, and every
file with its size, SHA-256 and `url`. Updaters have no account, so the
project they read must be public; keep private code in a separate project and
ship releases from a public one.

## Things not to do

- Do not run `cbx delete` unless the person has asked for that project to
  be deleted, by name, in this conversation.
- Do not run `cbx sign-out`. It costs them a token they have to fetch
  again and gains nothing.
- Do not guess a project name. `cbx projects` lists them; a folder that is
  already linked needs no name at all.
- Do not run `cbx take-down`. It destroys the files in a version and they do
  not come back. Say it exists and let its owner run it.

## If something refuses

The commands explain themselves — pass the message on rather than rewording it.
A refusal that says a token was not accepted means signing in; one that says a
project does not allow machines means its owner turned that off deliberately,
and the answer is to say so, not to find another route in.
