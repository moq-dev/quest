<p align="center"><img src="design/theme/logo.svg" alt="" width="96" height="96"></p>

# Quest

**A quest log for your repo and your agents.**

Readable plans, explicit dependencies, and reviewable Git changes. Quest keeps
your plans in your repository, so you and your agents read, claim, and finish
the same work. Each **quest** is a Markdown file scoped to one pull request: its
goal, what has been decided, and what stands in the way. A small TypeScript CLI
checks the links and dependencies. Skills help Claude Code and Codex plan the
work and set out on it.

It grew out of [MoQ](https://github.com/moq-dev/moq). This is the standalone
version, being built for use in other repositories.

**Early days:** validation, readiness, init/uninstall, and the planning,
execution, merge, and export skills are here. Release binaries are still being
built.

## Every plan is a file

```markdown
# [S] Add a download button

## Goal

People can download their data as a CSV from the settings page.

## Plan

Use the export endpoint. Show progress and let the user retry a failed download.

## Required

- [CSV endpoint](/quest/m0/export.md) - the button needs something to call
```

That file sits in your quest log, a tree under `quest/`:

```text
quest/
  README.md           # The roadmap
  m0/
    README.md         # First milestone, in priority order
    export.md         # Ready
    download.md       # Required: export.md
```

Folders are **epics**. A README's `Required` lists its children in
priority order, beside any other dependencies. The README is the epic's
own quest, and it becomes ready once its children have merged. The top folders
(`m0`, `m1`, ...) are **milestones** that give the work a delivery horizon.

When a quest is complete, its PR removes the plan and the links that depended
on it, so the quests that required it can become ready. A PR that leaves work
rewrites the plan to what remains. Milestones are never
deleted, so a PR that finishes one (its README has no `Required` left) removes
the links to that milestone too; `quest check` flags any it misses. The
finished plan stays in Git history, beside the code that completed it.

Work is taken through a live runner lock or an open change on the forge.
kix.quest records each active job in its database and reassigns a job whose
runner goes offline. On GitHub, a draft PR
opened from the quest's branch, including from a fork, claims the work;
`quest start` opens one. These states stay out of the plan file.

## Try it

Build from source with [Bun](https://bun.sh) (or enter the pinned shell with
`nix develop`), then link the `quest` command:

```sh
git clone https://github.com/moq-dev/quest.git
cd quest
bun install --frozen-lockfile
bun run build
bun link
```

With Nix, `nix run github:moq-dev/quest -- --help` builds and runs it instead.
Native Windows needs no WSL for Quest: see [installation and removal](docs/windows.md).
Windows ZIP artifacts are added by the next release containing this change;
older releases remain macOS/Linux-only.

The [CSV export example](examples/export/quest/README.md) is a small, working
quest tree. From this checkout:

```console
$ quest --root examples/export check
The quest log is in order: 4 documents checked.

$ quest --root examples/export unblocked
1	quest/m0/export.md

$ quest --root examples/export unblocked quest/m0/download.md
! [S] Add a download button        quest/m0/download.md
  Required:
    [S] Add a CSV export endpoint  quest/m0/export.md
```

With no path, `unblocked` ranks every ready quest. Given a path, it shows what
blocks that quest. On a terminal, a yellow `!` marks a ready quest and a grey
`!` a blocked one, and each size label takes its colour, like loot rarity: XS
grey, S green, M blue, L purple, and XL orange (your terminal's yellow). Set
`NO_COLOR` to keep the layout without colours.

Scripts and agents read the piped form, which is plain text:

```console
$ quest --root examples/export unblocked quest/m0/download.md | cat
quest/m0/export.md
```

Piped, a path prints that quest's blockers, with an explanation on stderr; no
blockers means no stdout. It exits zero for both ready and blocked quests; a
nonzero exit means the command failed.

## Prioritize ready work

`quest unblocked` ranks ready quests by milestone priority, descending number
of distinct transitive dependents, then existing tree order. Counts include
later milestones without moving their candidates ahead of earlier milestones.
Structural root, milestone, and epic membership does not add to the count;
real dependencies on an epic still reach its remaining work. Other prerequisites
may remain for a dependent after the selected quest finishes.

```console
$ quest --root examples/export unblocked
1	quest/m0/export.md

$ quest --root examples/export unblocked --json --limit 1
[{"path":"quest/m0/export.md","dependents":1}]
```

Each plain output line contains the count, a tab, and the path. On a terminal,
a heading explains the count. `--json` prints an ordered array, including `[]`
when no quests are ready; `--limit <count>` requires a positive integer.
Invalid trees fail with diagnostics and no ranking.
`quest-spawn` uses the ranking unless you explicitly select work in another order.

`--unclaimed` ranks the fetched upstream default branch's tree rather than
your checkout, so a stale checkout cannot offer a finished or deleted quest.
It then drops quests someone already holds: the quest's branch on the
upstream repository, or an open PR from that branch in any repository, forks
included. A branch whose tip is the head of a merged PR holds nothing, since
its work landed; a closed, unmerged PR's branch still holds its quest. It
lists each one it skips on stderr with its PR and how long ago that PR was
last active, so you can decide whether a stale claim should be taken over.
On GitHub, the upstream is found by walking up the remote's fork chain while
each parent's default branch has `quest/README.md`. In a contributor's fork,
the upstream is the project it forked, and the fork's own branches and PRs
count too; a remote that fetches from upstream and pushes to a fork works the
same way. A fork whose parent keeps no quests is its own upstream. A failed
lookup, such as an expired token or a network error, fails the command rather
than picking a different upstream. `--remote` picks a remote other than `origin`.
Off GitHub, only branches are checked.
Neither form inspects kix.quest runner locks or outside conditions.

## Find what waits on you

A quest waiting outside the tree says so in a `## Waiting` section, one item
per condition, each opening with who acts: `Maintainer:` for a decision or
action only the maintainer can take, or the outside party, such as
`moq-dev/moq:`. `quest check` rejects an item that names nobody.

```markdown
## Waiting

- Maintainer: open a Hetzner account; `GET /server` on the Robot API answers 200
- moq-dev/moq: a release carries the VA-API bindings
```

`quest waiting` lists every item, the maintainer's first, then by milestone and
the same downstream impact `quest unblocked` counts. Each line gives the
dependents, whether the quest is otherwise ready or still blocked, its path,
and the item; `--maintainer` keeps only the maintainer's, and `--json` prints
`{path, dependents, ready, waits}` objects. A draft PR hands itself back to
the maintainer with the same heading. `/quest-unblock` walks you through both.

## Claim a quest

`quest start` claims a ready quest so every claim is visible on GitHub:

```sh
quest start quest/m0/export.md
quest start --release quest/m0/export.md
```

It pushes an empty claim commit, built on the upstream default branch, to the
quest's branch (its path without `.md`), then opens a draft PR
from it right away and prints the PR's URL. It switches your checkout to the
claim on a new local branch, or fast-forwards that branch if it is already
checked out. A fork pushes to itself and opens the PR on its upstream, found
as for `unblocked --unclaimed`, so a fork with its own quests claims on
itself. It reads
readiness from the upstream default branch it builds on, not your checkout. It
fails on a tree `quest check` rejects, which can hide a blocker, and refuses a
blocked quest and one someone else holds; a rejected push means
another claimer got there first, and when two PRs race, the earliest open one
keeps the claim and the later one is closed. A branch left at a merged PR's
head is replaced, with a lease on that tip. A branch named after the claim
branch's directory, such as `quest/m1/epic` for `quest/m1/epic/one`, or inside
it, refuses the claim, since git cannot hold both; the refusal names it and
whether it is a merged PR's head, and leaves it in place. Off GitHub, it pushes
the branch without a PR.

`--release` deletes the branch, with a lease on its tip, and closes its PR, but
only while the tip is still an empty commit. Once work is on the branch, hand
the draft back instead: a `## Waiting` section in its body marks it as
waiting on the maintainer. Drafts handed back with the older `## Decisions
needed` heading count the same.

`quest start` exits 0 when done, 3 when it refuses (blocked, held, a branch in
the way, or work on the branch), 2 for invalid arguments, and 1 for other
failures. On GitHub it
uses `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`.

Draft claims are placeholders. This repository reports skipped checks on PRs;
its `Queue` workflow runs the checks when a reviewed head enters GitHub's merge
queue. Platform verification also runs after pushes to `main`.

## Check a quest's PR

A PR from a quest's branch must leave that quest accurate. `quest check --base
<ref>` runs the usual check, then compares the working tree with its merge base
with `<ref>`. When the branch is a quest's path without `.md` (an epic's is
`quest/<path>/README`) and that quest exists at the merge base, the diff must
delete or edit it. Any other branch passes. The branch defaults to the current one;
`--branch <name>` names the PR's head branch instead:

```sh
git fetch origin main
quest check --base origin/main --branch quest/m0/export
```

Fetch the base first, since a stale one can predate the quest. The
`quest-merge` skill runs this before landing a PR. A repository with
`quest` installed in CI can also run it on pull requests, where the checkout is
detached, so pass the head branch:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
- run: quest check --base "origin/$GITHUB_BASE_REF" --branch "$GITHUB_HEAD_REF"
```

The check is a floor, not a review: any edit to the quest passes, so reviewers
still judge whether a rewrite matches what remains.

A link into a submodule that is not checked out, as in a fresh worktree or
`actions/checkout` by default, resolves at the commit its gitlink pins when a
local git directory holds that commit, such as the main worktree's. Otherwise
`quest check` notes the submodule and skips its links rather than reporting
them broken.

## Move and delete quests

`quest mv` and `quest rm` move or delete a quest or an epic with `git mv` and
`git rm`, then fix the links so the tree still passes `quest check`:

```sh
quest mv quest/m0/export.md quest/m1/export.md
quest mv quest/m0/drain quest/m1/drain
quest rm quest/m0/download.md
quest rm -r quest/m1/drain
```

`mv` rewrites every root-absolute link to the moved path, and to everything
under a moved epic. `rm` drops each `Required`, `Related`, or `Closes` entry
that links to what it deleted, and the heading if that was the last entry.
It also drops every `Required` link to a finished milestone, including one it
just finished, but keeps the root's listing of the milestone.
Both stage the change, print one line per file (`R from -> to`, `D path`, or
`M path`), and report on stderr any other mention of the path, such as prose
or files outside `quest/`, without editing it. They run `quest check` on the
result and exit 1 if it fails, for example when a quest moved out of its epic.

An epic is its directory or README; removing one that holds other quests needs
`-r`. The root and milestones are never moved or removed. `mv` refuses a
destination that exists, and refuses to move a quest while it has a claim
branch or open PR on `origin`, or on the upstream that holds its claims,
since the branch would no longer name it.
Neither command touches branches or PRs.

## Merge quest lists

Concurrent PRs edit the same link lists: the base branch deletes finished
quests' lines while a branch inserts a new quest beside them. `quest init`
routes `quest/**` through a merge driver in `.gitattributes` and registers it
in the clone's git config, so a local `git merge` resolves those conflicts.

Inside a conflicting `Required`, `Related`, or `Closes` list, `quest resolve`
keeps the entries neither side removed and adds the ones either side
inserted, ours before theirs at the same place, matching entries by their
opening link. Prose, headings, an entry both sides rewrote, or one side
removed while the other edited, keep the usual conflict markers. Any `quest`
command registers the driver in a fresh clone or worktree whose
`.gitattributes` names it. Without `quest` on the merge's PATH, the driver
falls back to `git merge-file` and, when conflicts remain, prints to stderr
that the file's link lists were not auto-resolved. GitHub's merges ignore
drivers, so a PR shows as conflicting until a local merge from its base is
pushed.

The registered driver passes Git's conflict marker length and revision labels
to `quest resolve`, including the ancestor label for `diff3` conflicts. A direct
invocation defaults to seven-character markers and `ours`/`base`/`theirs`;
`--marker-size`, `--ours-label`, `--base-label`, and `--theirs-label` override
them. Labels must fit on one line. The fallback carries the same Git metadata
when `quest` is missing or too old to accept those options.

Existing configured drivers are preserved. For a checkout still using the old
quest-generated command, clear its local `merge.quest.driver` entry and run any
quest command to register the current one.

## Wait for pull request activity

`quest wait` blocks until a GitHub PR has a review, comment, review-thread
reply, reaction to the PR or one of its reviews, push, merge, close, removal
from the merge queue, disabled auto-merge or auto-merge left on a moved head, or
required CI result:

```sh
quest wait 101
quest wait https://github.com/moq-dev/quest/pull/101 --since 2026-10-07T12:00:00Z --timeout 1800
quest wait 101 --since abcdef0123456789abcdef0123456789abcdef01
```

A number uses the repository's `origin`, so it needs a checkout or `--root`
naming one; a URL works from any directory.
Authentication comes from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.
Without `--since`, the point is the current head's push time, so an existing
review on that head is included. GitHub lists a push seconds to minutes after
it lands, so for the current head the wait rereads the listing every 15 seconds
until the push appears, warning once. Any other SHA must be a listed pushed tip;
otherwise pass an ISO timestamp instead. Forks use the head
repository's activity. Deleted head repositories require a timestamp.
The initial PR commit listing must match the resolved head; a racing push or
GitHub's 250-commit listing limit fails clearly instead of guessing membership.

Output is plain, one line per event: timestamp (or SHA for a newly observed
commit), type, actor, and URL. The last line adds a resume cursor. Pass its
**last field** as `--since` on the next call. Cursors preserve commit membership
and events sharing a timestamp; treat them as opaque, and use them only for the
same PR. Explicit timestamps include events at that instant. Historical plain
pushes come from repository activity; pushes observed while waiting come from new
commit SHAs, regardless of git author dates. Force pushes come from the PR
timeline, excluding the one that created the starting head. A merge through
the queue prints `removed_from_merge_queue` about a second before `merged`, so a
poll can catch the removal alone; check `quest status` before treating it as a
failed merge. A label change prints as `labeled:<name>` or `unlabeled:<name>`
(spaces as `_`), so a queue that dequeues by removing its label wakes the
waiter; the authenticated account's own label changes are ignored. Actors are
printed without deciding
whose review counts. Edited issue comments print as `edited`, at their update
time; edits to the authenticated account's own comments are ignored. Comment
edits have their own cursor position and are read across every page, so editing
an older bot status comment wakes a resumed wait. Review edits remain outside
this command's scope.

CI results are read for the current head. The first required check to fail
prints `checks:failed` right away. `checks:passed` prints once nothing on the
head is still going (no pending check and no unfinished GitHub Actions run, which
may still create jobs), every check and workflow the base branch names is
present (except `quest land`'s, which no head carries), and every required
check passed; it names the last required check that passed and is dated when
the head went idle. Each prints once per head, with the check's name
(spaces as `_`) in the actor field and its details URL. Results count as
`quest status` counts them, so neutral and skipped results pass. Each job of a
workflow a ruleset requires is required.
Requiredness comes from the base branch's protection and rulesets, readable
with read access. A failed optional check prints separately as `check:failed`,
with its own name and details URL; it never names the aggregate required pass.
If the base branch requires no checks, every check is required. A result counts when it
was reached at or after the starting point, so a wait started after CI finished
still reports it; a push starts over for the new head, and the cursor records
what was reported, so resuming never replays it.

GitHub keeps auto-merge across a push by anyone with write access, so it can
land a head nobody approved. While auto-merge stays enabled on a head other
than the current one, `auto-merge:moved` prints once per head, with the account
that enabled it as the actor and `<pr-url>/commits/<sha>` naming the head it was
enabled on, read as `quest status` reads it.

Review-thread replies and reactions never reach the PR timeline, so they are
read separately. A reply prints as `replied`; a thread's first comment is part
of a review and prints as `reviewed`. Reactions on the PR body or a review
print as `reacted:<content>`, so a clean review that only leaves a 👍 prints
`reacted:thumbs_up`. Each poll reads the newest 100 reactions on each, so a
burst of more than that still wakes the waiter but prints only the newest;
reactions on other comments are not read. Replies and
reactions by the authenticated account are ignored, so an agent's own replies
do not wake it; activity from a person sharing that account is ignored too.
The cursor keeps a separate position for each source, so a reply that becomes
visible after a newer reaction is still reported.

Each poll makes one conditional timeline request and one conditional
review-comment request every five minutes once it has read the existing pages,
following a new page when the current one fills, plus one GraphQL query each
for reactions and checks. It reads the base branch's required checks once per
call. It honors GitHub's rate-limit headers, retries a 5xx or a dropped
connection a few times, and fails loudly on invalid responses.
There is no deadline unless `--timeout <seconds>` is supplied. Activity exits 0,
timeout exits 3, invalid arguments exit 2, and other failures exit 1; interrupt
with Ctrl-C to stop waiting. A timeout prints a resume point as its only line:
a cursor, or the given `--since` (else the head SHA) if setup had not finished.
Retry with it, not the original command, so activity that landed during the
first wait is still reported.

## Read a pull request's state

`quest status` prints a GitHub PR's current state in one call, such as after
`quest wait` wakes. It accepts the same PR argument and authentication as
`quest wait`, and reports facts without deciding whether the PR is ready or
whose review counts:

```console
$ quest status 128
url https://github.com/moq-dev/quest/pull/128
state open
draft false
head 0ade9d977d54c6f48152410532c58e9ea78db3d0
mergeable conflicting
merge-state dirty
review-decision -
auto-merge -
merge-queue -
landing-stopped -
checks success passed=14 failing=0 pending=0
review stale commented kixelated 2026-10-16T06:14:04Z https://github.com/moq-dev/quest/pull/128#pullrequestreview-5543745302
review current commented chatgpt-codex-connector 2026-10-16T17:57:16Z https://github.com/moq-dev/quest/pull/128#pullrequestreview-5551703054
thread PRRT_kwDOUhuoys6tUUV2 current chatgpt-codex-connector https://github.com/moq-dev/quest/pull/128#discussion_r4297708263 src/cli/gate.ts:115
hold quest:active LE_example 2026-10-16T17:57:16.000Z https://api.github.com/repos/moq-dev/quest/issues/events/123456 1 hour ago
```

Each line starts with its record type; any free text, a check name or a path,
comes last, and a missing value prints as `-`:

| Line | Fields |
| --- | --- |
| `url`, `state`, `draft`, `head` | The PR URL; `open`, `closed`, or `merged`; `true` or `false`; the head SHA. |
| `mergeable`, `merge-state`, `review-decision` | GitHub's values, lowercased. |
| `auto-merge` | Method, who enabled it, when, and the head it was enabled on. |
| `merge-queue` | Queue state, position, and when it was enqueued. |
| `landing-stopped` | The reason the latest merge-queue entry, auto-merge, or [`quest land`](#land-a-batch-with-quest-land) queue entry ended (such as `merge_conflict`, `failed_checks`, `manual`, `manually_disabled`, or `merged`), who ended it, and when. |
| `checks` | The head's rollup state and `passed=`, `failing=`, `pending=` counts. |
| `check` | `failing` or `pending`, `required` or `optional`, the result, details URL, and name. |
| `review` | `current` or `stale` against the head, state, reviewer, time, and URL of each reviewer's latest review. |
| `reacted:<content>` | Actor, time, and the PR or review reacted to, as `quest wait` names reactions. |
| `thread` | Node ID, `current` or `outdated`, last commenter, latest comment URL, and `path:line` of each unresolved thread. |
| `hold` | Label, acquisition token, acquisition time, verified GitHub event API URL, and age; `hold -` when no label holds it. Unknown acquisition facts print as `-` and `unknown age`. |
| `starter-hold` | A draft its starter owns: last activity time, PR URL, and `last active` age. Last activity is not when ownership began. |

The node ID is what GraphQL's `addPullRequestReviewThreadReply` and
`resolveReviewThread` take. Neutral and skipped checks pass. A required check
is one branch protection or a ruleset requires for this PR. `--json` prints the
same facts as one object with the fields `url`, `state`, `draft`, `head`,
`mergeable`, `mergeState`, `reviewDecision`, `autoMerge`, `mergeQueue`,
`landingStopped`, `checks` (`state`, `passed`, `failing`, `pending`), `reviews`, `reactions`,
`threads`, `holds` (`label`, `token`, `takenAt`, `age`, `eventUrl`), and `starterHold` (`lastActive`, `age`, `url`, or null). Ownership uses the state commands' shared reader without changing labels, and event links match the opaque acquisition token against GitHub's event listing. Long lists are paged; reactions are the newest 100 per PR or review,
as in `quest wait`. Any PR state exits 0, invalid arguments exit 2, and other
failures exit 1.

GitHub keeps auto-merge enabled across a writer's push without saying which head
it was enabled on, so the `auto-merge` line reads it from the auto-merge commit
body's `Quest-Land-Head` pin when [`quest land`](#land-a-batch-with-quest-land)
queued the PR. Otherwise it is the last push or merge to the head branch before
auto-merge was enabled, from the head repository's activity; it prints `-`
until GitHub lists the current head's push, which takes seconds to minutes, and
when a push shares the second auto-merge was enabled. A head there that differs
from `head` means a push followed auto-merge: disable it, or land the new head.

## Own a pull request

Before a session pushes to an existing PR, it takes the PR, so two agents
never work on one PR at once:

```sh
quest iterate 128            # add quest:active, printing a hold token
quest ready 128 <token>      # drop "Waiting" and mark it ready
quest release 128 <token>    # hand it back
quest merge 128 --land <sha> # auto-merge bound to that head; takes no label
```

A taken PR carries the `quest:active` label while an agent works on it.
Sessions often share a GitHub account, so taking it prints a hold token: the
ID of the timeline event that added the label. Every command refuses while a
`quest:*` label it holds no token for is on the PR, including another
session's `quest:active`; a draft its starter still holds, one without a
`## Waiting` (or older `## Decisions needed`) section; and a merged or closed PR, since a push after
the merge brings the branch back. The refusal names the holder's label, age,
and token, so you can decide whether to release a stale hold. When two
sessions add labels at once, the first label added keeps the PR and the other
backs off. Older quest versions add `quest:iterate` and `quest:ready`, which
hold a PR like any `quest:*` label; passing their token to `quest iterate`
swaps them for `quest:active`. Their `quest:merge` holds nothing and is
ignored.

`quest merge` takes no label: the head-pinned auto-merge or merge-queue entry
it creates is the queue signal, so a queued PR shows no hold. It refuses while
any session holds the PR, so release your own hold first. `--land` needs the full 40-character
head SHA and refuses once the head moves.
It enables auto-merge bound to that SHA, or merges at once when nothing is
left to wait for. `--squash` or `--rebase` picks the method, and it refuses one
the repository disallows; otherwise it uses the only method the repository
allows, or else a merge commit, and refuses when merge commits are off and more
than one method remains. On a base that requires the `quest land` check, it
queues the PR for [`quest land`](#land-a-batch-with-quest-land) instead.
On a base with GitHub's merge queue, which applies its own method, it enqueues
that head, or arms auto-merge bound to it while required checks may still be
pending. The queue builds each PR on the current base, so a head behind it is
enqueued as is. When GitHub refuses to enqueue the head, such as after the
base moved into a conflict, the command fails: fix the PR, for example with
`/quest-iterate`, and land it again.
On a base with neither the `quest land` check nor a merge queue, it refuses
while repository auto-merge is disabled. Follow the repository’s own landing
instructions in CONTRIBUTING.md or AGENTS.md, such as its label queue; never
retry with `--direct` unless the user asks. `--direct` permits the usual landing
behavior despite that repository setting.
On such a base, it also compares the live base against that head and refuses a
head that is behind or diverged: merge the base, rerun the repository's checks,
and land the new head. This is a preflight check; GitHub can still move the base
between that comparison and its head-pinned merge mutation. A PR that leaves
the queue unmerged shows why under `landing-stopped` in `quest status`.
GitHub keeps auto-merge across a writer's push, so disable it before pushing
to the PR; `quest status` and `quest wait` report a head that moved since.
The commands accept the same PR argument and authentication as
`quest wait`, and exit 0 when done, 3 when refused, 2 for invalid arguments,
and 1 for other failures.

This repository lands through GitHub's merge queue. Its required `Queue` check
runs `just check` and `just test` on each merge group on the self-hosted runner;
it skips on pull requests. `quest land watch` runs the fixer on dropped PRs and
re-enqueues healthy heads at the back of the queue.

## Land a batch with quest land

`quest land serve` runs on a maintainer's host, with one process per repository.
It replaces the Land workflow; landing needs no GitHub Actions.
The base requires the unreported `quest land` check, keeping auto-merge waiting.
Queue an approved head with `quest merge <pr> --land <sha>`.

```sh
QUEST_LAND_KEY=/run/credentials/quest-land/key quest land serve --app-id 1039466 \
  --sandbox /usr/local/bin/check-sandbox --fixer /usr/local/bin/fix-sandbox
```

The sandbox executable receives `<checkout> <base-sha>` as its two arguments,
with cwd set to the checkout. The SHA is `plan.base.sha`, the commit the tested
chain was built on, and is also exported as `QUEST_LAND_BASE`. Its environment
otherwise contains only `PATH` and `LANG`. The wrapper must isolate PR code from
the host's credentials and filesystem. Both the sandbox and fixer
wrappers **must run code as a different user from the App key owner**, for example
inside nspawn containers. Environment filtering cannot protect the key or later
merge tokens from a process running under the daemon's UID through `/proc`.
The sandbox gets a standalone shallow clone of the tested tip and every commit
through that base (`batch links + 1` commits), with no remote or alternates.
`HEAD` is the tested tip; `git diff "$2"` and `git merge-base "$2" HEAD` work,
and nothing links back to the daemon's repository. moq's host wrapper can run
`nix develop --command just ci "$2"`; quest's wrapper may ignore the extra argument. The fixer runs in an independent repository with batch history, no remotes,
no alternates, and no link to the daemon's private bare repository. Fetches and
chain construction use only that private repository in the state directory.
The sandbox runs the repository's checks
(`just check` and `just test` here). No credential or inherited home configuration
is passed to it. The daemon refuses to start without `--sandbox`. The optional
fixer runs as tracked background work, receiving the full log path followed by
PR numbers, with the same restricted environment (`PATH` and `LANG` only).
Its cwd is the standalone repository, checked out at `base` so the agent loads no
PR's instructions or tooling, with `batch` and `pr-<n>` branches beside it. The
prompt names each PR's branch and pinned head. For a base that fails its check
alone it receives only the log path, and the repository has only `base`.
The wrapper starts an ephemeral container and runs `quest land fix <log> [prs...]`
there, exposing that repository read/write and the log read-only at the given paths.
It supplies a fresh HOME, `OPENAI_BASE_URL` (the OpenAI-compatible Responses
endpoint, including `/v1`) and `OPENAI_API_KEY` (the gate's proxy client key).
The daemon never supplies these or any Git/GitHub credential, and the wrapper
must keep every other credential out of the container. Its network must reach the
model proxy and, so the fixer can build and test its fix, the package registries
and `github.com`/`codeload.github.com` that the repository's dependencies come from.
The prompt allows only those dependency fetches: no GitHub API, no push, no other
host. Codex login stays on CLIProxyAPI.
The wrapper waits for the payload, returns its exit status, and tears down its
container on exit or SIGTERM. A fixer gets 60 minutes from its start. A wrapper
that queues for a shared launcher prints `quest land fixer: admitted <unix-seconds>`
as one line to its output when the launcher admits the job, before any agent
output, so the wait for a slot does not use up the run. Waiting counts against
a total of 120 minutes from the spawn, which is also the deadline of a wrapper
that prints no such line. On timeout the daemon sends SIGTERM, allows at
least 10 seconds for container cleanup, then sends SIGKILL on a later collection. The payload defaults
to `codex exec`; `--agent <executable>` and repeatable `--agent-arg <argument>`
replace it for another CLI. It writes `<cwd>/quest-land-result.json`: an array of
`{number, action:"requeue", reason}`, `{number, action:"fixed", head, reason}`, or
`{number, action:"handback", diagnosis, recommendation}`, with no extra fields
beyond an optional `comment`, an optional `blame: true` on each PR that caused the failure (a blamed PR is
fixed or handed back), and on a handback an optional `log: [first, last]` citing the
failure log's lines, which its comment quotes. For the base alone, it writes one
object instead: `{action:"fixed", head, reason}` with the fix committed on `base`,
or `{action:"handback", diagnosis, recommendation}`.
The payload adds `agent` and `model` metadata to each result (`--model <id>`
selects the default Codex model; unknown models fall back to `Codex`).
Reasons and diagnoses are single lines. Fixed heads must be committed on `pr-<n>`.
A `comment` is Markdown of at most 4000 characters that the fixer wants on its PR.
The fixer holds no GitHub credential, since PR code it builds can read the
container's environment, so the daemon posts the comment as the bot when it
collects the job, before any outcome comment of its own. It quotes the text under the
recorded agent, strips HTML comments so the text can never carry the daemon's
hidden markers, defuses @-mentions, and redacts GitHub tokens, as it does for
every fixer text and log it posts.

Jobs and attempts persist across daemon restarts. A running fixer outlives a
restart only where the host leaves its process group alive (under systemd,
`KillMode=process` on the daemon's unit); otherwise its handback names the signal
and the restart. After the wrapper exits, the
daemon validates every result, ancestry, and protected path before lease-pushing
as the bot. The protected set as a whole must match the pinned head or its merge with the
current base, including content and mode. It covers `flake.nix`, `flake.lock`,
`shell.nix`, `default.nix`, `nix/`, `.envrc`, `.github/`, `.gitmodules`, and gitlinks
anywhere. Collection copies at most 100 MiB of Git metadata the fixer added into a
clean object repository. It skips the packs fetched at launch, whose objects the clean
repository borrows from the daemon's own. It ignores fixer configuration and never
follows the fixer's Git alternates. Pack indexes are rebuilt with
`git index-pack` rather than trusted; the fetch into the daemon's repository
checks every object and link, since the import enables `fetch.fsckObjects=true`. It records `mechanical fix by <recorded agent/model>: <reason>` and the new head in
`## Review`, and enables head-pinned auto-merge again on the fixed head, which keeps
the place of the pick it descends from. Healthy PRs go back to batches unchanged,
without a comment. A PR the daemon moved to its own recorded base merge before
parking it is collected at that merge: a requeue pins it, and a fix, built on the
pin, replaces it with a lease, since building on it would revert its newer base.
Any other moved head hands back. Forks refusing maintainer edits, refused pushes, invalid results,
crashes, or the fixer deadline hand back with a marked comment naming the exit
status or signal, with the tail of the job's retained log. A validated fix whose push
GitHub refuses, such as a merged base's `.github/workflows` changes that the App lacks
the `workflows` permission to push, is handed back with its resolution. So is a fix
that edits protected paths beyond what the base merge carries, such as a conflict in
`flake.nix` the fixer resolved: those never land automatically. The resolution is the
PR head, the base, the resolved tree, and the fixer's edits as a patch against the
merge's conflicted result, or against the head itself for a fix that merges no base,
sized to GitHub's 65,536-character comment limit. A maintainer
runs `quest land apply <pr>`, which refuses a moved head, rebuilds and checks that
tree, and prints an unpushed commit and its push command to run after reviewing it.
A resolution too large for the comment hands back plainly. A handback disables
auto-merge and carries the reason marker `quest status`
reads. Each failure a fixer job blames a PR for is a round of its maintainer pick; a PR
that only shared a broken batch has none. The fixer keeps going while each round
changes something, and a handback names the stop rule that ended it: a round with no
new commit for a failure that isn't flaky, such as a conflict requeued unchanged; the
failure a fix addressed recurring right after it; or three flaky rounds in a row,
where the fixer requeued a PR unchanged and the base passed alone. The fixer names
each failure's test or step, else the round counts the gate's check as one; a
conflict names the base it conflicts with, so one after the base moved is new. A new
maintainer pick starts a fresh history. Host provisioning and isolation
belong to the host; these commands are executable paths, not shell expressions.
Wrappers must expose only the supplied tree and log, never the state directory
or its private bare repository.

Batches alternate between the oldest and the newest queued PR as the base. Add
up to floor(log2 n) further PRs that merge cleanly in that order, resolving
quest links with `quest resolve`. A failed batch halves the next batch's size,
down to one PR, and each batch that lands grows it back by one; the order and
size persist in the state directory. Conflicting
additions stay queued. A PR whose required checks are still running stays queued
and sits out batches until they pass. If any are still pending two hours after
its pick (twice the default `--timeout`), the daemon comments once on that pick,
naming them, since a required check that never reports would hold it silently. The sandbox checks the tip once, without
bisection: success lands one squash commit per PR. A failure, or a base that
conflicts with the batch's first PR, parks those PRs for the fixer: they keep their
auto-merge and place, get no comment, and sit out batches while its
job runs, so the rest of the queue keeps landing. The fixer reads the log and blames
the PRs that caused it; the others go back to batches unchanged. When it blames
none, the daemon checks the base alone. A green base leaves every PR to the fixer's
verdict, as if blamed. A red base releases them all and halts the queue: nothing
lands until the base moves and its check passes. The fixer then runs on the base
alone. The daemon validates its fix as it would a PR's, protected paths
included, pushes it to a `quest-land/fix-<sha>` branch, and opens it as a pull
request for a maintainer to merge as an administrator. Only when the fixer cannot
fix the base, or there is no fixer, does an issue say the queue is halted. If the
base moves and still fails, the daemon closes that fix and runs the fixer on the
new base. Once a check of a moved base passes, the queue resumes, and the daemon
closes the issue and any fix it no longer needs. A job collected while the queue is halted releases its PRs without checking its own, possibly older, base. The daemon collects a finished fixer job even while a check runs.
Without a fixer, a failure ejects the batch instead: ejection disables auto-merge
and comments with the reason and the failing log, bounded by
size. When GitHub refuses one PR's squash merge, only that PR stops: a conflict is
parked for the fixer, a moved head or refusal is ejected, and the rest of the batch
stays queued. `quest status` reads the hidden reason marker. Full logs stay in the state directory: `--state`, or by default systemd's
`$STATE_DIRECTORY` or the XDG state home, never inside the checkout. A check
that runs past `--timeout` minutes (60 by default) is killed and fails its batch.

Every squash the daemon builds, and every base it merges into a PR head, drops
each `Required`, `Related`, or `Closes` entry linking to a quest the base
deleted since the PR branched, as `quest rm` would have. The PR wrote that link
while the quest was open, so the base finishing it is no fault of the PR's: a
sibling PR that links a quest another sibling finishes lands in the same batch.
A quest the base moved is a rename, not a deletion, and a link in prose stays.

As a batch is filled, each PR it reaches is squashed alone onto the current
base, and `quest check` runs on the result; PRs the batch does not reach wait
for a later round, so a long queue costs only each batch's candidates. A PR with findings the base lacks, such as
a mistyped link, is parked alone for the fixer, blamed
for those findings, so it never fails a batch; the fixer starts from that squash.
Without a fixer it is ejected as `failed_checks` with those findings. This check runs
in the daemon, never the sandbox: it parses quest files read from git objects
and executes nothing from the tree. A base without a `quest/` directory skips
it. A newly queued PR the batch reaches is also squashed onto the four PRs
landing soonest ahead of it; if any conflict, the daemon comments once with their numbers and files, so its author
can resolve the overlap before its turn. It is screened again only once
requeued.

Queue reads happen about once a minute and between batches. Pins, required
checks, reviews, conversations, rulesets, and classic protection remain enforced;
unsupported protection settings prevent landing. Heads moved since approval are
ejected as `head_moved`. Before landing, the daemon revalidates queue membership
and the base. Before landing each PR, the daemon merges the current base into its
head with `quest resolve` in the private repository if the head does not already
contain that base. The resulting tree must equal the tested chain link's tree.
It pushes that merge commit to the PR branch with a lease on the pinned head,
then calls GitHub's squash-merge API pinned to the prepared head. Up-to-date
heads need no merge commit. After each API merge, it compares the commit's parent
and tree before proceeding to the next PR.

If the PR branch push is refused for permissions, the daemon instead pushes the
tested squash to the base as a fast-forward, leased on the expected parent. It
closes the PR with a comment linking the landed commit.
Such a fork PR is closed rather than shown as merged by GitHub. A PR branch lease
failure ejects `head_moved`. A locally prepared or API squash tree mismatch logs
CRITICAL. A PR whose prepared tree differs ejects alone as `tree_mismatch`; an
already-squashed one stays merged. Either way, the rest of the batch stays queued
and is rebuilt and checked on the new base.

After an API refusal, the daemon re-reads mergeability and briefly retries
pending mergeability or a base refresh. It also retries while GitHub still
reports the pin as the head of a PR it just prepared, since GitHub can refuse the
merge for that stale head; only another writer's head ejects `head_moved`. It
likewise retries while GitHub calls the merge it just pushed conflicting, since
that merge holds the tested base; if GitHub still does after about 15 seconds,
the next round rebuilds the queue on the base as it then is.
A confirmed conflict parks only that PR for the fixer and a moved head ejects
only that PR; the rest stays queued. A persistent policy refusal ejects as `merge_refused` without the
fixer. Already-merged PRs are skipped. An unexpected API squash parent means the
base moved: the remainder is rebuilt without ejection.

Restart accepts a changed head only if the private state records that exact
daemon-authored merge for the same original pin and queue time, with the pin as
first parent, the tested base as second parent, and the tested tree. Author text
alone is not trusted. Every other changed head needs a maintainer to requeue it.
Checks remain bound to the original pin. Merged PRs drop out of the queue, and
an interrupted fallback close resumes from its private intent record without
repeating a landed base push. `flock` prevents two
daemons using the repository (including separate worktrees) or one state directory; `quest` must be on
PATH for the merge driver.

The App key stays on the host, in `$CREDENTIALS_DIRECTORY/github-app-key` or a
file named by `QUEST_LAND_KEY`, never in argv, where `/proc` would show it. Remote fetches and `ls-remote` use a separate repository-scoped installation
token with exactly `contents: read`, so private repositories are supported. The
read token is refreshed before expiry and retried once on authentication refusal.
Git receives it only through temporary `GIT_CONFIG_*` environment settings, never
in argv or repository configuration. Local `file://` fetches into sandbox and
fixer repositories remain credential-free. Write installation tokens are scoped
to this repository, with contents and pull requests write.
Tokens are minted for each push or API merge and passed only to trusted git
and GitHub clients, never the sandbox or fixer. A PR-branch push also requests
workflow write when the head-to-merge range carries workflow changes from the base. An API
merge requests workflow write when that PR's squash changes `.github/workflows`, or
when any commit the PR brings does (including a merge of a base that changed one),
since GitHub refuses an App's merge of a PR whose commits touch workflows. Queue API tokens, which disable auto-merge on ejection and
so need contents write, stay in the daemon, refresh before expiry, and are
replaced on a 401. Batch errors are logged and retried with bounded exponential
backoff. Grant the App the base ruleset's bypass and the read permissions needed
to inspect branch protection. The bypass actor's API merge of a pinned PR with
the unreported required `quest land` check must be verified on the live host.

## Watch GitHub's merge queue with quest land watch

On a base that lands through GitHub's merge queue, `quest land watch` runs on a
maintainer's host, one process per repository, and tells each PR the queue
drops unmerged why. With `--fixer`, it also runs the land fixer on each PR the
queue dropped for a failure or a conflict, and puts it back at the back of the
queue. It polls; the host needs no public endpoint.

```sh
QUEST_LAND_KEY=/run/credentials/quest-land/key quest land watch --app-id 1039466 --fixer /path/to/fixer-wrapper
```

Once a minute it reads the base's open PRs and their merge queue removals since
its last pass, and comments once on each PR the queue dropped, naming GitHub's
reason. For a failed or timed-out `merge_group` build, it finds the PR's last
merge group's runs (branch `gh-readonly-queue/<base>/pr-<n>-<base-sha>`) and
quotes each failing job, its failed step, and its log's tail; at build
concurrency 1 a group holds only that PR, so the failure is its own. A merge,
and the App's own removals, get no comment.

Each pick starts with an enqueue, by a writer or by the App, as when a
workflow enqueues Dependabot's PRs with the App's token. An App enqueue of a
head the watcher itself put back in the queue continues the watcher's pick
instead, until a handback ends it: the watcher's re-enqueue, GitHub's
auto-merge of it, or such a workflow picking the fixer's push. A failed build
or a conflict is recorded for the land fixer in `removal-<n>.json`, with the
full log beside it. A push since the removal, a person's removal, or a reason
the watcher does not know ends the pick, and the comment says the PR waits for
a maintainer to enqueue it again. The state directory remembers each removal
handled, so a restart neither misses nor repeats one; a crash between
commenting and recording finds its own comment's marker and posts nothing. The
first pass reads the ten minutes before it.

GitHub often leaves a PR whose auto-merge is armed out of the queue once it is
ready ([community#209348](https://github.com/orgs/community/discussions/209348)),
as for a pick `quest merge --land` armed while required checks ran. Each pass,
the watcher enqueues every such PR: open, armed, ready (its merge state is
`CLEAN`, `HAS_HOOKS`, or `UNSTABLE`: its required checks passed and it does not
conflict), not in the queue, and not added to it since it was armed. It
enqueues only the head auto-merge was armed on, with `expectedHeadOid` bound to
it: GitHub keeps auto-merge across a push, but a push by anyone but the land
fixer ends the pick, and a head it cannot tell yet waits for the next pass. An
armed PR whose required checks fail, or that conflicts, is left alone for
`/quest-iterate` and a new pick. The watcher's own re-enqueues are among these
picks. A refusal is logged once per pick and retried each pass.

With `--fixer`, the watcher takes each recorded removal, oldest first, while
its PR still waits as the queue dropped it:

- A conflict is first merged with the current base by the quest merge driver,
  in the daemon's private repository, as the host gate merges a base. A clean
  merge needs no fixer: the watcher lease-pushes it to the PR branch, records
  it in the PR body's Review, and re-enqueues it.
- Otherwise the fixer runs in the background, as for the host gate: the same
  credential-free wrapper, given the failure log and the PR's number, with the
  dropped head on `pr-<n>`, starting from the base the `merge_group` build
  was built on, or from the current base for a conflict, with the merge's
  conflicts as its log. At most `--fixer-jobs` (2) run at once; the rest wait
  for a slot. `--fixer-effort` (medium) sets the fixer's
  `model_reasoning_effort`, passed to the wrapper in `QUEST_LAND_FIXER_EFFORT`,
  which `quest land fix --effort` reads by default.

Each finished round is recorded in its pick's history, as the host gate
records its rounds: `fixed` for a fixer commit, `merged` for a clean merge,
`flaky` for a failed build the fixer requeued unchanged, and `unchanged` for a
conflict it requeued unchanged. Its failure signature is the test or step the
fixer names, falling back to the failing job and step, or, for a conflict, the
base it conflicted with. The pick keeps going while each round makes progress:
a round with no new commit for a failure that isn't flaky, the failure a fix
addressed recurring right after it, or three flaky rounds in a row hand it
back. A fix is validated, lease-pushed, and recorded in Review as for the host
gate, and a push GitHub refuses, or a fix that edits protected paths, is handed
back with its resolution for `quest land apply`. The watcher then puts the fixed, merged, or flaky head back
in the queue with `expectedHeadOid` bound to it: it enqueues a head whose
required checks have passed, and arms auto-merge on one whose checks still
run, so GitHub enqueues it once they pass. Either joins the back of the queue.
It comments on the PR with what it did, after any note the fixer wrote. A
handback, from a stop rule, the fixer, a refusal, a crash, or a timeout, is
posted with its reason and a recommendation, and the PR leaves the watcher's
care until a maintainer enqueues it again. A round whose pick ended while it
ran, by a writer's push or enqueue, is not applied, and its comment says so.

The watcher also keeps the repository's flaky tests in `flaky.json` in its
state directory: each flaky verdict, across every PR, by the failure signature
the fixer named, with the `merge_group` jobs that showed it. Each failed
build's round is told the tests that flaked before and are not yet disabled, in
`.git/quest-land-flaky.json` in its checkout, which `quest land fix` passes to
the agent. One verdict alone only re-enqueues the PR, since one judgment could
hide a real bug. When a listed test flakes again, the fixer also commits its
disabling on a `disable` branch from the base: the skip in the test
framework's own form, naming the follow-up quest it adds to the repository's
m0 `flaky` epic, `quest/m0/flaky/<name>.md`, to fix or delete the test. The
watcher validates that commit as it does a base fix, requiring exactly one new
follow-up quest, pushes it to `quest-land/flaky-<sha>`, opens it as a pull
request with its Review recorded, and enqueues it like any other, with no
maintainer's pick. A refused disable waits for the test's next flake, and a
pull request GitHub refuses to enqueue says so and waits for a maintainer.

It shares `quest land serve`'s App key, state directory, private repository,
and locks, so the two never run for the same repository at once. Without a
fixer its token asks for `contents: read`, `pull_requests: write`,
`actions: read`, which the App needs for the logs, and `merge_queues: write`,
which `enqueuePullRequest` needs. With one it also asks for `contents: write`,
for arming auto-merge and pushing fixes; a push that carries a workflow change
asks for `workflows: write`.

## Gate expensive commands

`quest gate <command> [args...]` holds an expensive command until the host has
room for it, across all of a user's repositories and worktrees:

```sh
quest gate bun run test
quest gate cargo build --release
```

Admission is sized from the host, with no configuration. Every platform waits
while the host-wide 1-minute load average exceeds the host's CPU count, or while
available memory is below one command's budget: 4 GiB, or a quarter of RAM on
smaller hosts, where RAM is capped by any container memory limit. On Linux,
available memory includes reclaimable host and cgroup file cache and is bounded
by the remaining budget of each enclosing memory cgroup. Load and memory count
work from every session and user. Windows reports no load average and macOS
counts reclaimable cache as used memory, so those signals are skipped there.

Both measures lag new work, so each command admitted in the last minute counts
as one more unit of load and takes one budget from available memory. While the
host has room even counting those, commands start at once: a burst of gated
test runs on an idle host starts together. Once only the raw load and memory
have room, commands start one at a time, 5 seconds after the previous admission.

The load limit applies only while a gated command is still running. Otherwise
the load comes from work the gate cannot wait out, so commands start one at a
time as if the raw load had room. A freshly booted hosted macOS runner is one
such host: Spotlight's first index holds its load at several times its CPU
count for the whole job. Available memory is still required.

A user's admissions on one host are recorded under
`~/.cache/quest/admissions/<hostname>`, whatever the caller's environment or
login session. The home directory comes from the user database, not `$HOME`;
an account missing from it, as in arbitrary-UID containers, uses
`/tmp/quest-<uid>/admissions/<hostname>`, and refuses that directory unless only
its UID can write it.

Two kinds of command go ahead of the rest. `quest gate --quick <command>` waits
at most a minute, then starts the command whatever the host's load and memory;
pass it only for cheap commands, such as a formatter or `quest check`, that cost
less to run than to hold back. A check that lands PRs goes first: with
`QUEST_GATE_PRIORITY=1` in its environment, every gate inside the check waits
for memory but never for load, whether or not other gated commands run. Both
record their admissions, so the other callers count them against the host's
headroom. Set the variable where the check starts, such as a merge queue
build's workflow or the land daemon's sandbox, rather than relying on a slot in
the host's ledger: a container's gates keep a ledger of their own, yet wait on
the host's load. `quest agent` drops the variable, as it drops an admission.

Each admission records the gate's process ID, and counts as running until that
process exits; a reused process ID only makes a command wait for the load
again. The gate holds no lock while the command runs, and it owns the
command's descendants. Once the command exits, any descendant still running is
killed, so a build or test run leaves nothing behind.

Cancelling the gate with SIGINT, SIGTERM, or SIGHUP delivers that signal to
every process it owns, as a terminal's Ctrl-C reaches its whole foreground
process group. Each one runs its own handling, even behind wrappers that would
not pass the signal on: a Bash script blocked on its foreground command, GNU
`time`, which dies without forwarding it, or Just. The gate then waits until
each process that got the signal has exited, so a phase that outlives the
wrappers around it still finishes its cleanup, and only then kills whatever is
left. A second SIGINT, SIGTERM, or SIGHUP kills everything at once. A cancelled
gate exits with 128 plus the signal's number. How far ownership reaches depends
on the host:

- Linux with a systemd 254+ user manager, unified cgroup v2, and Linux 5.14+
  runs the command in its own systemd user scope, as `quest worktree run` does,
  and owns every descendant, including ones that start their own process group
  or session. Only a process that asks another service manager to start it
  escapes.
  A cancelled gate waits until the scope is empty.
- macOS, and Linux without such a user manager (as in most containers and on
  Ubuntu 22.04), run the command as the leader of a new session and own its
  process group. A descendant that moves to another process group or session,
  as a daemon does, is outside it. The session has no controlling terminal: the
  command keeps the terminal as its streams, but cannot open `/dev/tty`, and
  Ctrl-Z suspends only Quest. Nothing reports that a process group emptied, so
  the command gets a pipe on descriptor 3, which every descendant inherits
  unless it or a parent closes it, as Bun and Node do for the processes they
  start. A cancelled gate waits until every process holding it has exited,
  including one outside the group that the signal never reached.
- Windows owns only the command itself.

A nested invocation runs immediately inside the admitted command, and a gate
inside another Quest scope, such as `quest worktree run`, leaves ownership to
that scope: an owner of its own would take the command out of the enclosing
one's reach. Internal compiler or test worker parallelism remains the command's
responsibility.

This repository's `just check`, `just test`, `just worker-check`, and
`just worker-test` run through the gate.

Arguments, working directory, environment, terminal streams, and the exit
status pass through, and waiting happens before the command starts. Each
process gets a cancelling signal once from Quest: a nested gate, or one inside
another Quest scope, leaves both the signal and the second signal's kill to
the enclosing owner, which already delivers them to everything it holds. A
signal sent with `kill` to such a gate alone therefore does not reach its
command. Just forwards SIGTERM to the command it runs, so that command gets it
a second time. There is no fairness guarantee, and no timeout except
`--quick`'s: any other command waits as long as the host stays busy.

## Review locally

`quest review` has the other vendor's model review the checkout's committed
branch before it is pushed for review: Codex when run from Claude Code, and
Claude Code when run from Codex. `--harness` names the reviewer instead; an
unknown harness, or a missing or logged-out CLI, is an error rather than a
same-model review, as is a login the API rejects mid-round, such as an expired
or revoked token. The reviewer uses its CLI's own stored login; a CLI with
none keeps the credential it reads from the environment (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code,
`CODEX_API_KEY` for Codex), unless a stripped `ANTHROPIC_BASE_URL` or
`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, or `_FOUNDRY` would send it elsewhere.
A logged-out error names the profile the CLI checked, `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`, or the default when unset.
Every review runs with a pinned model and effort that `quest review --help`
lists; `--model` and `--effort` override them.

```sh
quest review                                  # round 1 against origin's default branch
quest review --responses .tmp/responses.md    # round 2: the new head, with fixes and refutations
quest review --base origin/release --new      # a new session against another base
quest review --branch quest/m1/foo --responses .tmp/responses.md  # a detached checkout of that branch's head
```

Every turn reviews only the branch's own change, from the merge base of `HEAD`
with the base's tip, so a branch behind its base draws no findings on code the
base gained since, which a diff against its tip shows as reverted.
The first round runs the reviewer's own review, `codex exec review --base
<merge-base>` or Claude Code's `/code-review <effort> <merge-base>...HEAD`, then resumes that session for
one turn that applies the base's `REVIEW.md`, if any, and reports the findings
in one JSON schema. Later rounds resume the same session with the new head and
`--responses`, the author's free-text fixes and refutations, which a round that
reported findings requires. A refutation stands only when it cites evidence the
reviewer can check. A resumed session keeps the instructions it started with,
so a round whose applicable `AGENTS.md` or `CLAUDE.md` files changed starts a
new session instead, which still weighs the responses. Resuming keeps the
reviewer's prompt cache; Claude Code is asked for its 1-hour cache, and Codex
keeps its default. The session is kept per branch in the clone's
common Git directory, so any worktree of the clone resumes it; `--new` starts
over. `--branch` names the branch instead of the checked-out one, which a
detached `HEAD` requires, such as a checkout of a branch another worktree
holds, so its rounds continue that branch's session.

The reviewer is read-only: Codex in its `read-only` sandbox, ignoring
execpolicy rules, and Claude Code with only read tools and the Bash commands it
judges read-only, in `dontAsk` mode. Claude Code loads no settings files, so no
allow rule, even the user's own, widens that. Codex skips the user's config,
whose project trust would load the checkout's `.codex/config.toml` and start its
MCP servers outside the sandbox. Whether those flags isolate is up to each
CLI's release, so `just review-sandbox`, in this repository, plants project MCP
servers and hooks for both CLIs on a head, and for Claude Code local settings,
an allow rule, an `env` shell prefix, an API key helper, and a status line. It
runs `quest review` with the installed CLIs and copies of your logins, and
fails if any of it runs, the review trusts a new directory, or the reviewer's
flags let the planted rule allow a command. A login with no file to copy, such
as one in the macOS keychain, needs the CLI's credential exported instead:
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `CODEX_API_KEY`. It spends real usage, so CI never runs it; run it
after upgrading either CLI. The base is fetched first, since
the sandbox has no network. The reviewer follows the base's `AGENTS.md` and `CLAUDE.md`, at the
root and in each directory holding a changed path, never the checkout's, so a
change cannot instruct its own reviewer. The base's `REVIEW.md` is optional,
given every round, and chooses the review's stance, such as adversarial.

It prints the reviewer, model, and effort, session, round, base, head, a
`usage` line per turn (input tokens, the part read from the prompt cache, and output), the
finding count, then each finding as severity, `path:line`, and title over its
indented body. `--json` prints the same as one object. It exits 0 once the round
finishes, whatever it found, 2 for invalid arguments or a checkout or CLI that
cannot be reviewed, and 1 for other failures. `/quest-review` runs the rounds,
records them in the PR body's `## Review` section, and marks the PR ready.

## Headless agents

`quest agent` runs one headless agent turn per call, billed to one of the keys
in `QUEST_API_KEYS`, so `/quest-spawn api` launches every agent with one command
whose arguments name the whole launch:

```sh
quest agent start --harness claude --key 1 --model claude-opus-5-5 --effort high --permission-mode auto .worktrees/foo "/quest-start quest/m0/foo.md"
quest agent resume --harness claude --key 2 --model claude-opus-5-5 --effort high --permission-mode auto .worktrees/foo <session> "Take the recommendation."
quest agent stop .worktrees/foo
quest agent stop --all
```

Codex starts and resumes only in a checkout registered by `quest worktree create`,
on Linux with the `quest worktree run` supervisor available.
Ownership and host support are checked before keys are resolved. Each turn uses
the same lifecycle as `quest worktree run`: restore the reservation before the
turn, then release it and prune declared scratch after the agent and its
remaining descendants exit. Source changes and the session remain available
for resume, including after a decision pause or failed turn. Reinstall or rebuild
pruned dependencies when the next turn needs them. Claude continues to run
directly in the supplied checkout. Codex desktop threads use the desktop app's
native archival instead.

Options go before the worktree, and the prompt or message follows it, so text
starting with `-` is never read as an option. `--key` names a key by its
1-based position. The first launch resolves every 1Password `op://` entry in
one `op inject` and keeps the keys in a user-only
store under `$XDG_RUNTIME_DIR` (or the temporary directory), shared by the
repository's worktrees until `quest agent stop --all` deletes it. The agent
runs in the worktree with the user's environment minus the coordinating
session's harness variables (keeping `CLAUDE_CONFIG_DIR` and `CODEX_HOME`),
other keys, secret-manager tokens, and any `quest gate` admission or priority, plus its one
key. `--permission-mode` is Claude Code's permission mode, or Codex's sandbox
mode; the agent cannot prompt.

It prints `session <id>` as soon as the id is known, then `cost <dollars>` when
the agent reports it, `outcome finished|failed|exhausted|stopped`, a blank line,
and the agent's final reply. It never prints a key. It exits 0 when the agent
finished, 3 when the provider refused the key for lack of credit, 2 for invalid
arguments, 128 plus the signal number when interrupted, and 1 otherwise. `stop`
signals the agent and waits until its `start` or `resume` has reported.

The agent CLI and `op` run from their absolute paths on `PATH`, skipping
relative entries, so a worktree can never supply its own `claude` and receive
a key. They also run with only `PATH`'s absolute entries, so neither finds a
program it starts by name, such as `node`, in the worktree. On native Windows
the lookup tries `PATHEXT`'s program and batch extensions, a batch shim such as
npm's `claude.cmd` runs through System32's `cmd.exe` with its arguments
escaped, `NoDefaultCurrentDirectoryInExePath` stops Windows' implicit search of
the working directory, and `stop` ends the agent's whole process tree at once,
since Windows has no `SIGTERM`.

## Run kix jobs on your machines

`quest runner` turns a Linux or macOS machine with Nix into a
[kix.quest](https://kix.quest) runner, driving Claude Code or opencode with
that machine's own logins:

```sh
quest runner login --name laptop  # prints a link to approve while signed in to kix
quest runner account add          # Claude Code's own sign-in, in an isolated home
quest runner account add --console --label work
quest runner account add opencode # opencode's sign-in: OpenCode Go, ChatGPT, or an API key
quest runner account add opencode --model openai/gpt-5.5
quest runner account list
quest runner --slots 2            # runs jobs in the foreground until interrupted
```

`login` makes a token that never leaves the machine; the link carries only its
hash, and kix connects the runner once you approve it. Each account signs in
through its CLI's own flow in its own home: `claude auth login` in a
`CLAUDE_CONFIG_DIR`, or `opencode auth login` in a set of XDG directories, so
kix stores only an opaque account id, its kind, and a label. An opencode
account uses only the providers it signed in to, with `--model` or opencode's
default. Use Claude Code for Claude subscriptions, since opencode cannot sign
in to them. kix.quest/runners shows each runner's presence and sets the order
jobs use your accounts in.

Every job runs in its own checkout with the project's devShell, which the runner
builds with `nix print-dev-env` from the job's revision, honoring the flake's
`nixConfig`; a project without a flake gets a bootstrap job instead. An OS
sandbox (bubblewrap on Linux, Seatbelt on macOS) confines every command the
agent runs, the devShell's shellHook included: Claude Code's own sandbox on
Claude Code accounts, and on opencode accounts the same policy through
[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime),
which the runner sets as opencode's shell. Commands
write only to the checkout and a private temporary directory that is
also their `HOME`, cannot read account homes, the runner's state, or shared
temporary directories, and have no Nix daemon. A trusted revision's commands
reach only the npm, crates.io, and PyPI package registries, so its checks can
install dependencies; an untrusted one's reach no network host. npm's registry
also accepts publishes, so a prompt-injected agent holding someone's npm token
could publish the checkout there. The agent's file tools stay in the checkout
(opencode's may also use the private temporary directory, and its read tool
the output it saved), WebFetch is off, and nothing the checkout configures is
loaded: not its `.claude` settings, hooks, and MCP servers, nor its
`opencode.json` and `.opencode` plugins, tools, and MCP servers, and opencode's
language servers and formatters are off. The CLI itself, Claude Code or
`opencode serve`, runs outside the sandbox and outside the devShell, and its
commands start from a minimal environment, so its login, the opencode server's
password, and the kix tools' token stay out of their reach. This is an OS
sandbox, not a VM, and it narrows rather than removes the risk of running
agent commands on your machine.

On Linux the sandbox needs `bwrap` and `socat` (the flake's `runner` package
pins both) and unprivileged user namespaces; on Ubuntu 23.10 and later,
AppArmor allows them only for programs with a profile granting `userns`.
Merge jobs retain existing PR submodule pointers when merging the base. Their
`wait` tool wakes on GitHub webhook hints or reconnects and rereads the PR;
a hint never approves work. If someone moves the head, the maintainer can
continue from that exact head through the existing approval flow. The same
runner checkpoints and merges its unpublished source locally; conflicts pause
for a decision. Stale local changes are preserved in the runner's bare clone
under `refs/kix/checkpoints/<job>/`, and are not reapplied after another runner
publishes. Existing failover still restarts from the latest published branch
checkpoint. Initialized submodules leave their checkout intact until their
local commits and changes can be preserved explicitly; this path never deletes
them to force continuation.

The agent reports through kix tools: `checkpoint` summaries publish
work in progress to the job's branch, `ask` pauses the job on a decision for you,
and `deliver` publishes the result and its pull request, listing any suggested
follow-ups, which the inbox offers you to plan for 30 days after the job
completes. Expired offers cannot start a plan, and the job's history remains.
A job on an issue or
pull request reads it through `context`, since the runner holds no GitHub
token; a new plan reads your idea and pasted context there. kix publishes as its GitHub App, so the runner never pushes. A job that hits an account's limit
pauses for you to pick another account; the runner never switches on its own.
On SIGINT or SIGTERM, running work is published and its jobs move to another
runner. Runners take only trusted revisions until they can build untrusted
heads' devShells in a VM. A pull request's head is trusted only when every
commit beyond the default branch has a valid signature from a current
maintainer, so sign your commits (for example with
[SSH signing](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#ssh-commit-signature-verification))
for its iterate and merge jobs to run. Any other head, such as one kix
pushed to, waits in the inbox for a maintainer to review its commits and
approve that exact head; the approval lapses when the head moves, and counts
only while its approver is still a maintainer. A job resumes with another maintainer's answer
only once you approve it in the inbox. opencode runs as `opencode serve` on
localhost behind a password made for each turn.

The flake's `runner` package pins Claude Code 2.1.305 from its official release
manifest; opencode, sandbox-runtime (and on Linux, bubblewrap and socat) follow
this repository's lock (`nix run github:moq-dev/quest#runner -- runner`);
otherwise `claude`, `opencode`, and `srt` come from `QUEST_RUNNER_CLAUDE`,
`QUEST_RUNNER_OPENCODE`, and `QUEST_RUNNER_SRT`, or `PATH`. State lives in `$QUEST_RUNNER_HOME`, by default
`$XDG_DATA_HOME/quest/runner`; one `quest runner` runs in a home at a time. To keep a runner up, run `quest runner` as a user
service, such as a systemd user unit with `Restart=on-failure`.

## Prunable local checkouts

The experimental `quest worktree` commands share one disk budget across this
user's repositories and release a checkout's disk by deleting its declared
scratch in place. They only operate on Git worktrees they create; use the
owning application for Codex or other managed checkouts. Claude Code's
checkouts are Quest's own once `quest init` installs its hooks (see
[Claude Code checkouts](#claude-code-checkouts)).

Set a shared capacity and an explicit reservation in bytes, covering the
checkout and its expected build output. Measure representative jobs before
choosing the budget. Until a capacity is set, only free disk space limits new
reservations. Reservations serialize creators and account for concurrent
expected growth. They do not enforce filesystem quotas against arbitrary
writers, and Git objects stored in the shared repository are not charged.

```sh
quest worktree capacity 20000000000
quest worktree create example --reserve 3000000000 --scratch node_modules dist
quest worktree run example -- sh -c 'just install && just test'
quest worktree status
```

Creation prints JSON with the ID and the detached, locked checkout path under
`.worktrees/`, and records the `--scratch` paths. Names are unique per
repository; where several repositories use one, the other commands take the ID. `run` restores a released
checkout, runs the command there, and once it exits kills any descendants it
left behind. When no other run remains in the checkout, it releases it: the
declared scratch is deleted and the checkout keeps only its source. Put a whole
job, such as an agent session or a script that installs, builds, and tests, in
one run, since the next run starts without scratch.

`run` owns processes through a systemd user scope per run, so it needs Linux
5.14+ with a systemd 254+ user manager and unified cgroup v2; it fails on other
hosts. It handles signals as the gate does on such a host: SIGINT, SIGTERM, or
SIGHUP reaches every process in the run's scope, the run waits until the scope
is empty, and a second signal kills everything at once. A run inside another
Quest scope, such as a gate's, binds its own scope to that one, so the
enclosing owner's kill stops it too, and leaves a repeated signal's kill to
that owner: it may be the copy of SIGTERM that Just forwards.
Work handed to another service manager, such as `systemd-run` or a container
daemon, escapes the scope. If the supervisor itself is killed, its command keeps
running and its scratch is kept; the next `quest worktree` command drops the run
once its scope is empty and then releases the checkout. `status` lists each
run's scope, with the reason a run it cannot inspect is kept until an
inspection succeeds. `quest worktree stop example` kills what crashed
supervisors left in their scopes, waits until they are empty, and so releases
the checkout; it leaves runs whose supervisor is alive to that supervisor.

Release deletes only declared scratch, and refuses a path that Git does not
ignore, that holds tracked files or another Git worktree, or that is reached
through a symbolic link; links at or inside scratch are removed, never followed.
Missing paths are skipped, so release can be rerun. The checkout, its Git state,
and untracked files stay in place, and `status` charges what remains. A failed
automatic release is recorded on the checkout, which stays reserved. To manage a
checkout by hand, stop its unsupervised work first:

```sh
quest worktree release example
quest worktree restore example
```

`release` refuses while supervised runs are live. `restore` reserves the
checkout's disk again; then reinstall or rebuild its scratch, for example with
`just install`.

Once a checkout is finished, remove it and its record:

```sh
quest worktree remove example
```

`remove` never forces. It refuses while supervised runs are live, and refuses
modified or untracked files and any commit, at `HEAD` or under the checkout's
own refs such as `refs/bisect/`, that no branch or remote-tracking ref
reaches. A squash-merged change leaves its commits unreached, so they count as
preserved only when the GitHub upstream that holds origin's claims has a merged
PR whose head is exactly that commit; other commits need no forge or token.
It then prunes the scratch and refuses ignored files that remain, leaving the
checkout released, before `git worktree remove` deletes it. A checkout already
removed with `git worktree remove` only drops its record, as with `release`.
A failed creation stays charged until `release` drops it. Records live in
`$QUEST_WORKTREE_HOME`, or `$XDG_STATE_HOME/quest/worktrees` (default
`~/.local/state/quest/worktrees`). The registry lock of a process that exited on
this host is reclaimed; a live lock, or one held from another host, is never
stolen. This initial interface refuses unknown or changed checkout ownership.

### Claude Code checkouts

`quest init` adds hook entries to the repository's `.claude/settings.json` that
run `quest worktree hook` for Claude Code's `WorktreeCreate`, `WorktreeRemove`,
`SubagentStart`, and `SubagentStop` events, so `quest` must be on the `PATH`
Claude Code runs hooks with. The hook then creates every worktree Claude makes
in the repository, for `--worktree`, `EnterWorktree`, isolated subagents, and
background sessions, and Claude no longer copies `.worktreeinclude` files into
them.

Each is a `quest worktree` checkout under the main checkout's `.worktrees/`,
named as Claude names it. Like Claude's default, it starts from the remote's
default branch as last fetched (`origin/HEAD`), or from the session's commit
when that is unknown; Claude's `worktree.baseRef` setting no longer applies. With only a name to go on,
it declares the main checkout's top-level ignored entries as scratch, except
`.worktrees/`, `.claude/`, and entries holding a nested repository, and
reserves the main checkout's disk usage without `.git` and those checkouts. A
subagent's checkout is released when the subagent finishes or stops to wait for
an answer, and restored when it resumes, with a note telling it to reinstall
its scratch. Another `SubagentStop` hook that keeps a subagent running defeats
this: Claude continues the subagent without a `SubagentStart`, so it works on
without its scratch until it reinstalls it. Claude never removes a subagent's checkout itself, so remove a
finished one with `quest worktree remove`, which also recovers one whose
session crashed. When Claude removes a session's checkout, `quest worktree
remove` decides: a checkout holding unpreserved work is kept.

## Work with your agents

Open this repository in Claude Code or Codex. The binary carries the skills;
a repository installs only a stub per skill that runs `quest skill <name>`, so
the version you pin decides what your agents follow:

| Skill | What it does |
| --- | --- |
| `quest-plan` | Ask the questions that turn an idea into scoped quests. |
| `quest-grill` | Settle open decisions through rounds of questions, each with a recommendation. |
| `quest-recurring` | Plan a quest whose finishing PR creates its next occurrence, and what gates it. |
| `quest-import` | Bring open GitHub issues into the planning conversation. |
| `quest-export` | Turn active quests into GitHub issues before leaving Quest. |
| `quest-audit` | Find conflicting, stale, or misprioritized quests, then resolve them. |
| `quest-start` | Claim a ready quest, complete it, and open a PR. |
| `quest-spawn` | Triage ready quests and send several agents out in parallel. |
| `quest-iterate` | Iterate on an open PR to settle its open decisions, fix CI and review findings, and push. |
| `quest-review` | Review a PR's branch locally with the other vendor's model, then mark it ready for review. |
| `quest-merge` | Queue a PR to land, running `quest-iterate` first when it needs work. |
| `quest-complete` | Decide which open PRs to merge, then queue them. |
| `quest-afk` | Keep starting agreed work while you are away, leaving every decision for your return. |
| `quest-unblock` | Settle what quests and draft PRs wait on you, and clear waits that have resolved. |
| `quest-delete` | Abandon a quest, deleting it in its own PR. |

Use `/quest-plan` in Claude Code or `$quest-plan` in Codex. Skills coordinate
within your agent session. A started quest stops at a pull request; merging is
a separate invocation, so you review every change.

To bill spawned agents to API keys instead of your agent's account, export
`QUEST_API_KEYS` with one or more whitespace-separated keys and run
`/quest-spawn api`. Entries may be secret references such as 1Password `op://`
URIs, resolved in one `op inject` when the first agent starts; a 1Password
service account token (`OP_SERVICE_ACCOUNT_TOKEN`) avoids even that prompt. Each
quest runs through [`quest agent`](#headless-agents) as a headless `claude -p`
or `codex exec` process on one key; a key whose credit runs out is dropped, and
spawning stops once every key is exhausted.
Disable auto-reload or set a spend limit in each provider console so draining a
key cannot charge a card. Agents run as your user, so they are not isolated from
the other keys.

To use Quest in your own repository, paste this into your agent:

```text
Follow https://github.com/moq-dev/quest/blob/main/SETUP.md to set up Quest here.
```

The [getting started guide](docs/getting-started.md) covers what happens next.
`quest guide` prints the format and workflow.

## Where this is going

The first release should let you paste one line into your agent to set Quest up,
bring in existing GitHub issues, work through quests, and leave again without
losing your plans. The binary carries the skills, your tool manager (mise or nix)
pins its version, and your repository's instructions stay yours. Quest supports
macOS, Linux, and [native Windows](docs/windows.md).

The hosted service is moving to [kix.quest](https://kix.quest): maintainers
plan issues, start ready quests, and act on GitHub PRs through a decision UI.
Hosted work will use explicitly selected maintainer or donor API funding.
Automatic project history passes read updates since their prior issue/PR
boundaries, including timestamp ties. Explicit Refresh starts or resumes a full
history pass; successive refreshes repair cached issues deleted without a
webhook. Open draft bodies are read only to classify `## Waiting`.
[The first milestone](quest/m0/README.md) lists the quests that remain.

## Contributing

Quest is planned in the open with Quest itself: [its quest log](quest/README.md)
is the backlog, and contributors claim quests from the same log their agents
read. To work on Quest:

```sh
nix develop
just install
just check
just test
just build
```

CI runs the same checks. See [CONTRIBUTING.md](CONTRIBUTING.md) for the details.

MIT or Apache-2.0, your choice. The CLI, initial skills, and development setup
were extracted from [MoQ at `2bb3e6e`](https://github.com/moq-dev/moq/tree/2bb3e6e3f3f357be7bb5f7a8e7feb4348cfdefe4).
Original notices are preserved in [LICENSE-MIT](LICENSE-MIT) and
[LICENSE-APACHE](LICENSE-APACHE).
