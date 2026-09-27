# cbx

The command line for [CodeRook](https://coderook.com), version control and
project hosting for projects of any size. Every save is a complete,
compressed snapshot of the folder; projects are private or public at your
choice; and nothing stored on CodeRook is used to train AI. There is also a
[desktop app](https://coderook.com/download) and the website, and all three do
the same things. [How CodeRook works](https://coderook.com/docs).

```
npm install -g @coderook/cli
cbx login
```

The command is `cbx`, and the split it names is the same one git and GitHub
have. **CBX is the engine** — content-defined chunking, whole-snapshot
versions, the `.cbx` bundle format. **CodeRook is the host** it talks to. You
run `cbx`; you sign in to CodeRook.

That is why the names do not match everywhere, and the mismatch is on purpose:

| | |
| --- | --- |
| `cbx …` | the tool — what you type |
| `coderook.com`, `@coderook/cli` | the service, and the package it ships in |
| `coderook://project` | a remote URL, which names the host it points at |
| `CODEROOK_TOKEN`, `%APPDATA%\CodeRook` | credentials for a CodeRook account |

It uses the same engines as the desktop application — the same scanner, the
same `.gitignore` rules, the same upload, download and `.cbx` bundling — so a
project moved by one is understood by the other.

## Install

Requires Node 20.11 or later, and nothing else.

```
npm install --global @coderook/cli
```

That installs `cbx`. It also installs `coderook` as an alias for it, so
anything written against the old name keeps working; the two are the same
program and either can be used.

Or from this repository:

```
cd cli
npm install
npm run build
npm link
```

## Sign in

Create a personal access token in **Settings** on coderook.com, then:

```
cbx sign-in
```

The token is written to a file only your account can read:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\CodeRook` |
| macOS | `~/Library/Application Support/CodeRook` |
| Linux | `$XDG_CONFIG_HOME/coderook`, or `~/.config/coderook` |

For automation, set `CODEROOK_TOKEN` instead and nothing is written to disk.
`CODEROOK_API_URL` points the tool at a different service.

## Everyday use

```
cbx status                    what is here that is not saved yet
cbx submit -m "Fixed the parser"
cbx get                       fetch the latest version over this folder
cbx clone my-project          fetch a project into a new folder
```

`status` and `submit` act on the current directory unless you name another.
The first time either runs in a folder, it looks for a project on your account
whose name matches and links the two, so a folder you already uploaded from
the desktop is recognised rather than treated as new.

`submit` sends only what changed. Files the service already holds are not
uploaded again, and the version it records still names every file in the
project — a version is a snapshot, not a difference.

## Lines of work

A project can have more than one line, so two people can save without one
landing on top of the other.

```
cbx tracks                    the lines this project has
cbx track                     the line this folder saves to
cbx track spike --new         start a line and switch to it
cbx track main                switch back
cbx submit --track spike -m "Try the other encoder"
```

Switching says where the next save goes and nothing else. No files move and
nothing is fetched, so it is instant and safe to change your mind — run
`cbx get` afterwards to bring that line's files into the folder.

The line is remembered per folder, not per account, so two checkouts of one
project can sit on different lines. A folder that has never been switched
saves to `main`, which is what every folder meant before lines existed.

A name that does not exist is refused rather than created. A typo in a branch
name is an ordinary thing to do, and a line called `mian` puts work somewhere
nobody will look for it — `--new` is how you say you meant it.

If two saves land on the same line anyway, the second becomes a merge waiting
on a decision. `cbx merges` lists them and `cbx merge <ref>` walks
through it; `cbx tracks` shows them beside the ordinary lines, because
somebody looking for where they can save needs to see the one they cannot.

## A history on this machine

A folder can keep its own history, with no account and no connection:

```
cbx init                          start one; it lives in .cbx/
cbx save -m "First playable build"
cbx status                        what changed since the last save
cbx diff                          the same, line by line
cbx log                           the saves on this line
cbx switch -c new-movement        start a line here; no files change
cbx switch main                   go back; only files that differ are rewritten
cbx merge new-movement            bring that line's work into this one
cbx restore --from main~2         put the folder back two saves
cbx restore src/player.ts --force throw away unsaved changes to one file
cbx push                          send this line's new saves to CodeRook
cbx pull                          bring CodeRook's new saves here
cbx pull my-project               start from a project already on CodeRook
```

Nothing in `.cbx/` is sent anywhere until you push. Each save becomes a
CodeRook save of its own, and the first push creates the project, private,
unless the folder is already linked to one. If somebody saved to that line on
CodeRook since your last push, nothing is sent and you are told to pull
first. If you both saved, pull merges their saves with yours; push then sends
the merge.

A merge takes whatever only one side changed, merges text files both changed
line by line, and marks only what is left. Fix the marked files and
`cbx save`, or take one side with `cbx merge --mine` / `--theirs`
(`--path <file>` for one file), or `cbx merge --cancel` to put everything
back.

Once a folder has a history, `status`, `diff`, `log`, `switch`, `merge`,
`push` and `pull` answer from it. Everywhere else they mean what they always meant.

`restore` and `switch` stop and list the files if they would overwrite an
unsaved change. `--force` discards those changes. Files the history has never
held are never touched.

## Proposals

A line gets back to main by being proposed. The proposal is checked and
reviewed before it lands, and it follows the line: saving onto it afterwards
changes what is proposed rather than needing a second one.

```
cbx propose -m "Faster encoder"     offer this folder's line to main
cbx proposals                       what is open (--all for the rest)
cbx merge M-3                       look at one: reviews, checks, decisions
cbx merge M-3 --ask sam,priya       ask people to review it
cbx merge M-3 --apply               land it, once nothing is in the way
```

`--into` proposes into a line other than main, and `--from` proposes a line
other than the one this folder is on. "Fixes #12" in the title or body closes
issue 12 when it lands. The same proposals are on the website's Merges page
and behind **propose** in the desktop application.

A line can require approvals, and an approval from whoever proposed it does
not count. Checks come from actions: `cbx actions --on-proposal Tests` runs
Tests whenever a line is proposed or saved onto, and its result is a required
check. `--on-save` runs an action on every save, and `--by-hand` only when
somebody starts it.

A **protected** line refuses saves made straight onto it — from `cbx submit`,
the desktop application and `git push` alike — so the way in is a line of your
own and a proposal. It also cannot be put back on an earlier save, and a merge
cannot land on it over a conflict or a failing check.

## Who can reach a project

    cbx visibility                        # what it is now, and what each level means
    cbx visibility public                 # list it on your profile
    cbx visibility unlisted my-project    # link only: kept off your profile and out of search
    cbx visibility private                # back to you and the people you invite

Making a project public or unlisted asks first and says what becomes readable.
In a script there is nobody to ask, so pass `--yes` (or `-y`); without it the
command refuses rather than waiting. Going private never asks.

A public project's page offers only its named versions that have not been
hidden (see `cbx promote` and `cbx mark --hide`).

## Pages

A public project can be served as a website: a Unity WebGL build, a Godot web
export, a Vite or React build, or plain HTML.

    cbx pages                              # on or off, the address, the version and folder it serves
    cbx pages auto                         # find the build in the published version and turn it on
    cbx pages on --folder Build/WebGL      # serve a folder you name
    cbx pages on --spa                     # unknown paths serve index.html (--no-spa undoes it)
    cbx pages on --isolate                 # cross-origin isolation, for Godot 4 threads
    cbx pages on --version 12              # serve one version rather than the newest published
    cbx pages off                          # stop serving it

Each project gets an address of its own, `https://<project>--<owner>.<pages domain>/`.
Until the service's Pages domain is set up, the address reads "goes live when
the Pages domain is set up".

Only published versions are served — a save made public with `cbx promote` or
from History — and the project must be public. Only its owner can change the
site. Turning it on asks first, because the site runs the project's code in
anybody's browser under its name; pass `--yes` in a script. Turning it off
never asks.

When nothing published looks like a site and you run `cbx pages auto` in the
project's folder, it looks on the disk for a build (`dist/`, `build/`, `out/`,
`public/`, `Build/WebGL/` and the like). A build the ignore rules leave out is
named along with the rule responsible, and it offers to add the `.gitignore`
line that keeps it in (`!/dist/`). It does not save or publish anything: the
next steps are `cbx submit`, `cbx promote`, then `cbx pages auto` again.

## Ignore rules

```
cbx ignore                     show the rules in force
cbx ignore --init              write a starter .gitignore
cbx ignore --suggest           what is here that probably should not be sent
cbx ignore --suggest --apply   add the confident ones
```

`cbx rules` is the same command under another name, so anything already
written against it keeps working.

`--suggest` looks at what the folder would actually send and names the
dependency directories, virtual environments and build output in it, with how
much each is costing you. Lines marked `+` are safe to assume and are the ones
`--apply` writes; anything that might be the work itself is marked `?` and left
for you, because the cost of guessing wrong is a project that is not backed up.

Rules live in the project's own `.gitignore`, so CodeRook, git, the website
and the desktop application all read one file. A `!` line puts something back.
Personal exclusions that should not reach a collaborator belong in
`.git/info/exclude`.

In a git repository, a file git already tracks is sent even if a rule matches
it — the same exception git makes, so a broad rule written after the fact does
not quietly drop committed source. Git's own `.git` directory is never sent,
and the service refuses a save with any path inside one.

## Moving a repository here

`cbx import` takes a snapshot — the files as they are now, one version, no
history. To move off a host entirely, with the history intact:

```
cbx transfer https://github.com/owner/project
```

GitHub, GitLab, Codeberg and any self-hosted Gitea or Forgejo. Every commit
becomes a version and every branch a line, so it takes a while on a long
history — the commit count and an estimate are printed before it starts.

**It goes through the public route on purpose.** The history is published by
running `git push` against the CodeRook remote, exactly as you would by hand.
A transfer that used a private path would prove only that a private path
exists.

| | |
| --- | --- |
| Comes across | commits, every branch, tags as releases, the description |
| With `--issues` and a read token | the open issues |
| Does not come across | pull requests and reviews, CI configuration, collaborators, stars |

The project is created **private** whatever the source was — publishing
somebody's code as a side effect of moving it is not recoverable. Pass
`--visibility same` to mirror the source, or `--visibility public`.

A private repository needs a read token in the environment — `GITHUB_TOKEN`,
`GITLAB_TOKEN` or `FORGE_TOKEN`. It is never taken as a flag, never stored,
and there is no OAuth flow: holding your forge credentials to run a one-off
migration sits badly beside a promise that your work is not handed to anybody.

The report at the end lists what arrived and what did not, rather than leaving
the absence to be discovered later.

## Using git instead

Installing the CLI also installs `git-remote-coderook`, so git talks to
CodeRook directly — both ways:

```
git clone coderook://my-project
git push coderook main
git fetch
```

It exists so that every editor's built-in git panel works with CodeRook
without a plugin. If you are not already living in git, `cbx submit` is
the simpler tool and this is not an upgrade on it.

**Pushing.** Each commit becomes a version, oldest first, with its message
kept. Later pushes send only what is new, so the usual case — a few commits —
is quick; a first push of a long history is not, and the helper says how many
commits it is about to publish before it starts. Branches become lines, and a
branch pushed for the first time starts from the commit it forked at rather
than from wherever the project happens to be.

**Cloning and fetching.** Every version becomes a commit, keeping its message,
its date and who published it. This works on any project, including one that
has never been near git — a project built entirely with `cbx submit`
clones into a normal git history. A fetch only downloads versions this clone
does not already have.

**What it does not do:**

| | |
| --- | --- |
| Tag kind | A lightweight tag comes back annotated. CodeRook records a name, not which sort of tag made it. |
| Force pushes, branch deletion | Refused — versions are immutable, so there is nothing to rewind to. |
| Submodules | Skipped on push, and it says which paths. |
| The executable bit | Everything arrives as a normal file. A script cloned back needs `chmod +x`. |

**On round trips.** Push then clone gives you back the same *files*, not the
same *commit ids*. A commit id covers its author, committer and timestamps,
and CodeRook records who published a version rather than the original stamps —
so the history you get back is a faithful copy of the contents and an honest
approximation of the commits. Two people cloning the same project do get
identical ids as each other.

Merges are asymmetric for the same reason. A publish states one base version,
so pushing a git merge records one parent and the fork is lost — the merged
tree is exact, the shape is not. Reading back is richer: a version that really
has two parents is rebuilt as a real git merge.

Each version records the commit it came from, so a colleague pushing the same
project does not republish history the project already holds. Pushing a git
history into a project whose versions came from somewhere else is refused
rather than interleaved.

### The names are the same

There is no translation table to learn, because there is nothing to translate.
The commands carry git's names:

```
cbx push          cbx pull          cbx clone
cbx log           cbx status        cbx branch
cbx checkout      cbx merge         cbx tag
```

Each is the CodeRook command it always was, reachable by the name a git user
would reach for: `push` is `submit`, `pull` is `get`, `log` is `versions`,
`branch` is `tracks`, `checkout` is `track`, `tag` is `release`. The original
names still work and mean the same thing. The one exception is a folder with
a history of its own (`cbx init`): there `log`, `switch`, `merge`, `push`
and `pull` work on that history.

That is also what the git remote does. `git push` performs the operation
`cbx push` performs — the same code decides what changed, the same code
publishes it. The remote is a way to reach these commands from git, not a
second implementation of them that happens to agree.

**What does not appear on that list**, because git has no such idea and
inventing one would be pretending: `projects`, `delete`, `people`, `watch`,
`issues`, `propose`, `proposals`, `actions`, `runs`, `logs`, `runner`,
`tokens`, `licence`, `ai`. Use
them by name; nothing about them changes when a version arrives through git.

`git commit` has no CodeRook equivalent either, and should not: it is local to
git, and a version is not made until something is published.

### Tags and releases

`git push --tags` publishes each tag as a release, because that is the same
statement in the other vocabulary — the service puts it plainly: *"a release
is a Version with a name on it, not a different kind of object."*

```
git tag -a v1.0 -m "First stable release"
git push coderook v1.0
```

The tag names the version its commit already became; it does not publish
anything, so push the branch first. An annotated tag's message becomes the
release notes and a lightweight tag brings none — the commit's own message is
deliberately *not* used, since nobody wrote it about the release.

Cloning reverses it: every release comes back as a tag on the right commit.

From the command line, `cbx release v1.0` names the newest save the same way,
and `cbx notes 41 --edit` writes its release notes.

Assets are separate and unaffected. They attach to a version from a run's
artifacts or with `cbx attach <file>`, so a release made by pushing a tag
simply has none until something adds them — which is what a release without a
build has always looked like.

## Bundles

```
cbx bundle                    pack this project as <name>.cbx
cbx unbundle backup.cbx       extract one
cbx inspect backup.cbx        see what it holds  (--files to list them)
```

A `.cbx` is the CodeBox bundle format: content-defined chunks, Zstandard where
it helps, raw where it does not, and a SHA-256 for every chunk and file.
Extraction is verified and atomic — a damaged bundle fails rather than leaving
a half-written tree.

## Claude Code

Run this **in a terminal**, not inside Claude Code:

```bash
cbx skill
```

That is the whole setup. It writes `~/.claude/skills/coderook/SKILL.md`, and
from then on you ask for what you want in ordinary words:

> save this to CodeRook

> what have I changed?

> what versions does this project have?

Claude works out which commands to run. You can also call it by name with
`/coderook`.

**The skill is called `coderook`, not `cbx`.** `cbx` is the command line, run
in a terminal; the skill is the file that teaches Claude how to use it. Typing
`cbx skill` *into* Claude Code asks it for a skill by that name and it will
tell you there is not one — which is correct, and is why the line above says
where to run it.

`cbx skill --project` writes it into `./.claude` instead of your home
folder, so it travels with the repository and everybody who clones it has it
too.

Sign in once per machine first — `cbx sign-in` — or set `CODEROOK_TOKEN`
in automation. The skill will not save anything without asking you first, and
never deletes.

## Installing it as a plugin instead

If you would rather not install the command line first, CodeRook publishes a
plugin marketplace of its own:

```
/plugin marketplace add https://coderook.com/marketplace.json
/plugin install coderook@coderook
```

That fetches the same package from npm and brings the skill with it. The
marketplace is a plain file on coderook.com rather than a git repository, so
there is no repository to clone and no second account anywhere.

One thing to know: a plugin install puts the package in Claude Code's plugin
folder, not on your `PATH`. The skill copes with that on its own by falling
back to `npx -y @coderook/cli`, but `npm install --global @coderook/cli` is
faster if you plan to run commands yourself as well.

## A structured connection instead

The skill teaches Claude the command line, which needs no configuration. If you
would rather it had structured tools, there is an MCP server as well. It works
with Codex too, which is the reason it exists.

Claude Code:

```
claude mcp add --scope user coderook -- npx -y @coderook/cli mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.coderook]
command = "npx"
args = ["-y", "@coderook/cli", "mcp"]
```

To share it with everyone on a project, commit this beside the code:

```json
// .mcp.json
{
  "mcpServers": {
    "coderook": {
      "command": "npx",
      "args": ["-y", "@coderook/cli", "mcp"]
    }
  }
}
```

It offers five things, all of which read: your projects, a project's versions,
the files in a version, one file's contents at a version, and what has changed
in a local folder. It cannot save, delete, or sign in or out.

## Checking things

```
cbx doctor
```

Reports the tool's version, where its configuration lives, whether the service
is reachable, and who this machine is signed in as.

## Exit codes

`0` on success, `1` on failure. Every command prints why it failed on standard
error, so a script can branch on the status and log the reason.

## Source and licence

The `cbx` command line and the CBX engine it is built on are open source under
the Apache License 2.0: <https://github.com/AlexC1991/cbx>. The storage format
and the sync protocol are specified there too, so other tools can read and
write the same histories.

Copyright 2026 ACCA Gaming Productions. "CodeRook" is a name of ACCA Gaming
Productions, and the licence grants no right to use it.
