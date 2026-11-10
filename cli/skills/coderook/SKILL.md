---
name: coderook
description: Save, browse and restore versions of a project on CodeRook — a version host where every version is a complete snapshot, reached with the cbx command or with plain git. Use when asked to save, submit or push work to CodeRook, check what has changed, look at a project's versions or files, fetch a project, start or switch a line of work, resolve a save that landed at the same time as somebody else's, build a project's executables for Windows, Linux and macOS from one machine (cbx build), or publish a mod to a game's mod repository or set one up (cbx mods). Also inspect shared workspace credits and separate PR allowances.
allowed-tools: Bash Read
---

# CodeRook

CodeRook stores whole snapshots of a folder. A version names every file the
project had at that moment, so restoring one never depends on the versions
around it, and there is no staging area, no branches to rebase and no history
to rewrite.

Everything here is the `cbx` command line (also installed as `coderook`), or
git itself through CodeRook's remote helper. Run them with Bash.

**Which one to use.** If the folder is a git repository (`git rev-parse` works
in it), prefer git — see *Working in a git repository* below. Each commit then
arrives with its own message, instead of one snapshot standing in for many.
Use `cbx submit` for folders that are not git repositories.

## Remote work without a full checkout

Use `cbx workspace` when the person wants to continue a CodeRook project from a lightweight laptop. Do not clone the full project unless that work needs local files. Start with `cbx workspace list <project>` or open a named draft with a unique `--key`. Keep its ID and revision, read/search the needed paths, edit with explicit hashes in a JSON `--data-file`, review the diff, then save the authorised revision. Retry a lost response using the same operation key and arguments. Saving and deploying are different actions.

`cbx workspace show <project> <id>` includes the administrator-configured recipe commands and target information. Run a named recipe, inspect its job with `logs`, and use `cancel` if needed. Only deploy an explicitly requested target and a saved version with applicable checks. A missing recipe requires configuration; running a local terminal command does not change remote files.

To hand a draft to a machine that is not signed in as the owner, run `cbx workspace assign <project> <draft> --name "Laptop"`. It prints a token that reaches that one draft (read the project, edit, save and run its checks; no deploys, settings, other drafts or more tokens). Tell the person to give it to the other machine privately; never repeat the token yourself. On that machine: `cbx sign-in` (paste the token), `cbx workspace checkout <project> <draft> [folder]`, edit the files, then `cbx workspace push` (add `--save -m "…"` to save, `--dry-run` to preview). A checked-out folder is not a linked folder, so `cbx submit` does not apply there. A handed-over machine's saves never land on the draft's line directly: they go to the draft's own line `drafts/<name>-<id>` and open a pull request into it, which the owner or a reviewer approves and merges (see it with `cbx pr list`). Saves made signed in as the owner go straight to the line. `cbx workspace assignments` lists live tokens and `cbx workspace unassign` ends one; archiving the draft ends them all.

`cbx machines [project]` shows the PCs working on a project: linked folders and handed-over drafts, the version each holds, how far behind the line it is and its unsaved file count, then the runners. A machine appears when cbx status, get, submit or a workspace command runs there; `CODEROOK_NO_PRESENCE=1` keeps one off the list. Check it before assuming nobody else is mid-change.

`cbx mcp --workspaces` opts into the remote workspace tools using this account's stored token. The original `cbx mcp` stays read-only. A token needs explicit workspace edit/run/deploy grants for those actions; never print its value. The remote plugin can connect directly without this CLI.

Native jobs require CLI 0.38.0 or later on the selected Windows laptop and a matching `cbx runner --name` and label. The named recipe can select `includePaths` so only needed inputs download to a temporary job folder. Hosted jobs continue with the desktop PC off. Native execution, local GPU features, toolchains and signed-in services need their own suitable machine/setup. Remote task notes share project handover state, not proprietary chat history.

## Usage and limits

Use `cbx workspace usage <project>` (no draft ID needed), or the remote MCP `workspace_usage` tool, to read the repository payer's current workspace and PR usage. These balances are shared across that payer's repositories, not a separate grant for each project. Report included, spent, reserved and available purchased workspace credits separately, along with the PR allowance and resetsAt. Use returned amounts; do not infer a balance from a plan name. A reservation is held for a running job, not another charge, and remainingCredits already excludes included reservations. Reading usage does not purchase credits or enable alerts.

Paid accounts normally receive separate workspace and PR allowances of 20% of normalized monthly base-plan revenue, excluding storage add-ons; returned values also reflect any explicit PR override. Verified free accounts have a small workspace allowance; inspect freeVerified instead of promising it to an unverified account. Hosted execution consumes included workspace allowance first, then purchased workspace credits. AI PR reviews and requested changes use their separate PR allowance; hosted PR checks use the workspace pool once. Workspace top-ups do not refill PR allowance. Ordinary remote file reads/edits and own-machine runners do not consume hosted runtime credits. A positive displayed balance does not guarantee a job can start: funding, reservations, concurrency and execution permissions still apply.

When a job is queued, inspect `cbx workspace logs <project> <draft> <run>` or remote `workspace_run_status` and its summary. If it is waiting for credits, explain the wait and the returned reset date; retain the run ID instead of repeatedly queuing replacements or polling in a tight loop. The runner reserves a funded lifecycle before starting and can stop at that deadline; unused funds are released after confirmed teardown. Included allowances reset on the first of each UTC month; purchased credits carry over. When PR allowance is exhausted, AI reviews/changes pause while manual PR work continues.

Purchases and recurring/notification settings stay in CodeRook Subscription; an authorized owner can also use the repository Settings top-up popup without leaving the repo. A minimum US$1 top-up funds 750 workspace credits (75% of the retail amount; 1,000 credits represent US$1 of metered usage). Automatic refills require the owner's explicit setup and consent, begin only after included spend is exhausted, and obey the owner's monthly cap. These tools cannot purchase credits, change payment settings or promise an automatic refill. If usage access is refused for a collaborator or a draft-scoped token, explain the restriction and ask the billing owner to inspect it on the site; do not broaden token permissions.

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

**The first save from a folder must say which project it is.** A folder that
is not linked goes to a new project named after it — unless the account has a
project with a name like it, and then `submit` stops and lists them. Do not
guess: show the person the list and ask. Then run one of:

```bash
cbx submit --into <project> -m "…"   # this folder is that project
cbx submit --new -m "…"              # a separate project (add --name if the name is taken)
cbx link <project>                   # link only; send nothing yet
```

Never start a second project for work that already has one. A folder copied to
another machine, another operating system or another path is still the same
project: `cbx link` it.

Send only what changed; the version still names every file. Write the message
yourself from the actual diff rather than asking for one — a message like
"update" helps nobody reading the history later.

**Ask before running this.** Saving is the one thing here that leaves a mark on
somebody's account, and a version saved by mistake is a version they have to
explain. Propose it, say what it would send, and let them agree.

`cbx submit -n` shows exactly what would be sent without sending it. Use
that freely; it is safe and it is the honest way to answer "what would this
upload?".

## Working in a git repository

CodeRook is a git remote. `npm install --global @coderook/cli` puts the helper
(`git-remote-coderook`) on PATH; the plugin and `npx` do not, so check with
`git ls-remote coderook://<project>` before relying on it.

```bash
git remote -v                                        # is there a coderook:// remote already?
git remote add coderook coderook://<project>         # if not
git push coderook main                               # each new commit becomes a save
git push coderook <branch>                           # a branch becomes a line
git push coderook v1.2.0                             # a tag names a version
git fetch coderook                                   # bring other people's saves in
```

If the project was started with `cbx submit` or the desktop app, the first push
is refused with a message saying so. When the repository holds that project,
`git push -o adopt coderook main` saves the current commit on top of what is
there, once; plain pushes work from then on. **Ask before adopting** — it is a
save like any other. If the project is somebody else's work under the same
name, push to a new name instead.

Git's limits here: no force pushes or branch deletions (saves are permanent), a
merge commit arrives as one save holding the merged tree, and a commit holding
a credential is refused — take the key out of history rather than looking for
a way round.

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
GET /projects/{owner}/{slug}/releases             every release, with its downloads
GET /projects/{owner}/{slug}/releases/latest      newest release and its files
GET /projects/{owner}/{slug}/updates/latest.yml   electron-updater feed
GET /projects/{owner}/{slug}/versions/{v}/files         every file, with digests
GET /projects/{owner}/{slug}/versions/{v}/file?path=    one file
GET /projects/{owner}/{slug}/versions/{v}/archive       the version as a zip
GET /projects/{owner}/{slug}/versions/{v}/last-changes?path=   which version last changed each entry
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
project they read must be public, but its source need not be:

```bash
cbx release 1.4.0 --downloads public   # notes, attachments and feed public; files stay private
cbx releases                           # public / downloads public / private, and the addresses
```

**Ask before `--downloads public`**: it publishes the attached files to anyone.
One project holds the code and ships the app; a second "releases" project is
no longer needed.

## Building executables for every platform

```bash
cbx build --plan                  # how this machine would build each target
cbx build --target win,linux,mac  # build them into .coderook/build/<target>/
```

It builds on this machine, with the tools it has, and uploads nothing. Run
`--plan` first and read it out: a target marked "no" says what would build it
(Docker, a Mac, cargo-zigbuild) — pass that on rather than installing things
unasked. `--ship` attaches the results to the newest save, so **ask before
`--ship`**, as before any save. A project's own build description lives in
`coderook.build.json`.

## Pull requests

A pull request is a proposal: a line offered to another line (`cbx propose`
opens one). Read and review them with `cbx pr`:

```bash
cbx pr list                         # what is open on this project
cbx pr view M-3                     # reviews, checks, conversation, what blocks merging
cbx pr files M-3                    # what it changes
cbx pr comment M-3 --line src/app.ts:42 -m "…"
cbx pr approve M-3                  # or request-changes M-3 -m "…"
cbx pr merge M-3
```

**Ask before** `approve`, `request-changes`, `merge`, `close` and any comment:
each is the person speaking or acting, and is seen by others. An approval
stops counting when new saves land on the line, so re-check after pushing.
Every pull request carries a `coderook/malware` check: what the line adds or
changes is scanned before it can land, and a failure names the file. Do not
try to get round it.

## Private files

`cbx private add "design/"` keeps matching files out of everything outside the
project (listings, zips, clone, Pages). Ask before changing the list: it
decides what strangers can see.

## Runs

`cbx runs`, `cbx logs 12 --follow` to watch one, `cbx cancel 12` to stop one,
`cbx rerun 12` to run it again, `cbx approve 14` for one waiting for approval
(ask before each). Workflows can be YAML files in `.rook/workflows`; check
them with `cbx actions check` before saving. Never print or echo secrets:
`cbx secret set NAME` asks for the value itself, so let the person type it.

Runs receive `CODEROOK_API` and `CODEROOK_PROJECT`. Only jobs allowed to act on
the project receive a temporary `CODEROOK_TOKEN`; credential-free workspace
checks and artifact builds do not. Project secrets require approval of the
saved source and exact execution settings, and never reach PR checks.
Credential-capable jobs cannot keep artifacts; build them in a separate
credential-free job and publish the approved artifact in the release job.
Native runners must use CLI 0.41.1 or newer for chunk-safe masking and isolated
HOME/npm settings. They remain trusted machines, not a filesystem/network sandbox.

## Issues, forks and security

`cbx issue view|comment|close|label|assign`, `cbx fork`, `cbx security`. Ask
before closing, labelling, assigning, forking, or sending anything: each is the
person acting where others see it. A security report is private to the
project's owner; never put vulnerability details in a public issue.

## Releases

`cbx release v2.0 --draft --generate-notes` then `cbx release publish`;
`cbx verify owner/project v2.0 ./file` checks a download; `cbx deps` lists
known vulnerabilities in the lockfiles. Ask before publishing.

## Mod repositories for games

A game's maker can run a mod repository: players' game clients read a signed
catalogue from it, modders publish to it, and nothing is listed until it
passes the repository's rules and a malware scan.

```bash
cbx mods info zt1                                   # a repository's rules, for anybody
cbx mods publish ./BetterTrees --repo zt1           # zip, upload, wait for the checks
cbx mods publish ./HD-Art --repo zt1 --part animals # one part of a bigger mod
cbx mods list zt1                                   # your mods and how their checks went
cbx mods create my-game --name "My Game" --allow .png,.ogg,.json
```

`publish` reads the folder's `mod.json` (or the repository's manifest) for the
mod's id, name, folder and version; `--id`, `--name`, `--folder` and
`--version` override it. It waits up to 30 minutes for the checks and prints
what failed, file by file — pass that on as it is. Programs and scripts
(`.exe`, `.dll`, `.ps1`, `.js` …) are refused in every repository, so do not
try to rename one past the check. **Ask before `publish`**, as before any
save: it makes the mod public once it passes. Ask before `remove`, `block`
and `delete`, which only the person should decide. The game-side protocol
(signed requests, the catalogue signature, downloads) is at
https://coderook.com/docs#mod-repositories.

## Things not to do

- Do not run `cbx delete` unless the person has asked for that project to
  be deleted, by name, in this conversation.
- Do not run `cbx sign-out`. It costs them a token they have to fetch
  again and gains nothing.
- Do not guess a project name. `cbx projects` lists them; a folder that is
  already linked needs no name at all.
- Do not pass `--new` to get past the question `submit` asks. It exists for a
  separate project the person wants, not to avoid choosing.
- Do not run `cbx take-down`. It destroys the files in a version and they do
  not come back. Say it exists and let its owner run it.

## If something refuses

The commands explain themselves — pass the message on rather than rewording it.
A refusal that says a token was not accepted means signing in; one that says a
project does not allow machines means its owner turned that off deliberately,
and the answer is to say so, not to find another route in.
