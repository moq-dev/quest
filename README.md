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
    README.md         # The first milestone
    export.md         # Ready
    download.md       # Required: export.md
```

Folders are **epics**, and the quests in a folder are its children; its
README lists only what blocks it, never its children, and holds back every quest
under it until that clears. The README is the epic's
own quest, and it becomes ready once its children have merged. The top folders
(`m0`, `m1`, ...) are **milestones** that give the work a delivery horizon.
Finishing a quest deletes its file and edits no README, so PRs that finish
sibling quests do not conflict.

When a quest is complete, its PR removes the plan and the links that depended
on it, so the quests that required it can become ready. A PR that leaves work
rewrites the plan to what remains. Milestones are never
deleted, so a PR that finishes one (its folder holds no other quest and its
README has no `Required` left) removes the links to that milestone too;
`quest check` flags any it misses. The
finished plan stays in Git history, beside the code that completed it.

Work is taken through an open change on the forge. On GitHub, a draft PR
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
Releases from v0.3.0 on ship Windows ZIPs; v0.1.0 is macOS/Linux-only.

The [CSV export example](examples/export/quest/README.md) is a small, working
quest tree. From this checkout:

```console
$ quest --root examples/export check
The quest log is in order: 4 documents checked.

$ quest --root examples/export unblocked
1	quest/m0/export.md

$ quest --root examples/export unblocked quest/m0/download.md
! [S] Add a download button        quest/m0/download.md
  Blocked by:
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
of distinct transitive dependents, then path order, which compares numbers by
value so `m10` follows `m9`. Counts include
later milestones without moving their candidates ahead of earlier milestones.
Structural root, milestone, and epic membership does not add to the count;
real dependencies on an epic still reach its remaining work. Other prerequisites
may remain for a dependent after the selected quest finishes.

```console
$ quest --root examples/export unblocked
1	quest/m0/export.md

$ quest --root examples/export unblocked --json --limit 1
[{"path":"quest/m0/export.md","dependents":1,"hosts":[],"models":[{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},{"harness":"codex","model":"gpt-6.1-sol","effort":"medium"}]}]
```

Each plain output line contains the count, a tab, and the path. On a terminal,
a heading explains the count. `--json` prints an ordered array, including `[]`
when no quests are ready, and gives each quest the `hosts` its `## Hosts`
section names (empty when it runs anywhere) and the ranked `models` that write
it, as [Route work by size](#route-work-by-size) describes; `--limit <count>`
requires a positive integer.
Invalid trees fail with diagnostics and no ranking.
`quest-run` uses the ranking unless you explicitly select work in another order.

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
Neither form inspects outside conditions.

## Schedule work for a date

Work that must not start before a day, such as a yearly filing, says so in a
`## Scheduled` section holding one date, optionally followed by why:

```markdown
## Scheduled

- 2027-01-15 - the filing window opens
```

Until that day on your local calendar the quest is blocked: `quest unblocked`
leaves it out, `quest unblocked <path>` names the date, and `quest start`
refuses it. On an epic or milestone README, the date holds back every quest
under it. A past date no longer blocks. `quest check` rejects anything but one
real `YYYY-MM-DD` date.

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

A draft PR hands itself back to the maintainer with the same heading in its
body.

`quest waiting` lists every item from both, the maintainer's first, then by
milestone and the same downstream impact `quest unblocked` counts; a draft
ranks as the quest its branch carries. Each line gives the dependents, whether
the quest is otherwise ready or still blocked, its path or the draft's URL, and
the item; `--maintainer` keeps only the maintainer's, and `--json` prints
`{path, pr, dependents, ready, waits}` objects. A draft's item that names no
party is the maintainer's. Drafts come from
the upstream's open PRs, found as for `unblocked --unclaimed`; without the
remote, off GitHub, or when GitHub cannot be read, it lists the tree's items
and warns that drafts were skipped. `/quest-complete` walks you through them.

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
checked out. A local branch left from an earlier attempt is not moved: the
claim still succeeds, with a warning to switch to it and merge the claim
commit. A fork pushes to itself and opens the PR on its upstream, found
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
waiting on the maintainer.

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

Fetch the base first, since a stale one can predate the quest. `quest merge`
runs this on the head it lands. A repository with
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

`quest check` also compares the repository's skill stubs with the skills its
binary carries, and reports a missing, outdated, or retired one. A job that
checks a PR with a binary built from the base passes `--no-stubs`, since that
binary's skills would reject a PR that changes a stub; the PR's own binary
checks them in its own `quest check`. This repository's merge queue and
`quest merge` do so.

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
just finished, and every epic's `Required` link to a quest in its own folder.
Both stage the change, print one line per file (`R from -> to`, `D path`, or
`M path`), and report on stderr any other mention of the path, such as prose
or files outside `quest/`, without editing it. They run `quest check` on the
result and exit 1 if it fails, for example when a quest moved into a folder
with no README.

An epic is its directory or README; removing one that holds other quests needs
`-r`. The root and milestones are never moved or removed. `mv` refuses a
destination that exists, and refuses to move a quest while it has a claim
branch or open PR on `origin`, or on the upstream that holds its claims,
since the branch would no longer name it.
Neither command touches branches or PRs.

## Merge quest lists

Concurrent PRs can edit the same link list: the base branch deletes a finished
blocker's line while a branch adds another blocker beside it. `quest init`
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

A driver an older `quest` registered is replaced with the current one by the
next `quest` command; any other configured driver is preserved.

A clean merge can still leave this branch's list links to quests the base
finished, which `quest check` then flags. `quest check --fix` drops every
`Required`, `Related`, or `Closes` entry linking to a quest deleted in the
history of `HEAD`, and of `MERGE_HEAD` during a merge, that the working tree
lacks, and every epic's `Required` entry naming a quest in its own folder,
which the epic already waits for, and prints `M path` for each edited
document. That part also migrates a tree from before epics stopped listing
their children. It then promotes a section heading written below `##` to `##`
where nothing but its own content follows it before the next `##` heading, and
no `##` section of that name exists. It leaves the edits unstaged and refuses
while a quest file has unresolved conflicts. A quest moved rather than deleted,
a link that never named a quest, a link in prose, and any other misleveled
heading stay for `quest check` to report.

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
until the push appears, warning once. Any other SHA must be a tip the listing
shows a push, or a merge into the branch such as **Update branch**, moving it to;
otherwise pass an ISO timestamp instead. Forks use the head
repository's activity. Deleted head repositories require a timestamp.
The initial PR commit listing must match the resolved head; a racing push or
GitHub's 250-commit listing limit fails clearly instead of guessing membership.

Output is plain, one line per event: timestamp (or SHA for a newly observed
commit), type, actor, and URL. The last line adds a resume cursor. Pass its
**last field** as `--since` on the next call. Cursors preserve commit membership
and events sharing a timestamp; treat them as opaque, and use them only for the
same PR. Explicit timestamps include events at that instant. Historical plain
pushes come from repository activity, and a historical merge into the branch
prints as its new commit; pushes observed while waiting come from new
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
head is still going (no pending check, no finished job whose GitHub Actions run
is still going, and, once a cancelled check makes it read the head's runs, no
unfinished run, since each may still create jobs), every check and workflow the base branch names is
present (except `quest land`'s, which no head carries), each required check
from the app its requirement names, if any, and every required
check passed; it names the last required check that passed and is dated when
the head went idle. Each prints once per head, with the check's name
(spaces as `_`) in the actor field and its details URL. Results count as
`quest status` counts them, so neutral and skipped results pass, a rerun
supersedes an earlier run of the same check from the same workflow, and a cancelled check a newer run
of its workflow replaced is dropped. Each job of a
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
review-record diff-identical 5f1c2e9a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e
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
| `review-record` | Whether the PR body's [`## Review` record](#review-locally) still covers the head, and the head it names last: `current` when it is the head, `diff-identical` when `git diff <base>...<head>` prints the same as for it, `stale` otherwise, or `unknown` when GitHub cannot compare them, such as a diff too large; `-` when the record names no full SHA. Whose record counts is the reader's call. |
| `auto-merge` | Method, who enabled it, when, and the head it was enabled on. |
| `merge-queue` | Queue state, position, and when it was enqueued. |
| `landing-stopped` | The reason the latest merge-queue entry, auto-merge, or [`quest land`](#the-watchers-own-queue) queue entry ended (such as `merge_conflict`, `failed_checks`, `manual`, `manually_disabled`, or `merged`), who ended it, and when; `-` once the PR has entered the merge queue or auto-merge again since. |
| `checks` | `failure` if any check fails, else `pending` if any is pending or a requirement is unreported, else `success`, and `passed=`, `failing=`, `pending=` counts, all from the checks that count; `-` when the head has no checks and the base requires none. |
| `check` | `failing` or `pending`, `required` or `optional`, the result, details URL, and name. A required check or required workflow nothing reports yet prints as `pending required expected -` with its name, followed by `(from app <id>)` when the requirement names an app, or the workflow's repository and path, as `owner/name:path`. |
| `review` | `current` or `stale` against the head, state, reviewer, time, and URL of each reviewer's latest review. |
| `checkpoint` | Each bot reviewer that approves or requests changes, such as one whose approval the base requires, its round, and its review's URL, when that review is of the head and its latest verdict there, ignoring plain comments, is neither an approval nor a dismissal, at the end of its third, sixth, ... round: [`/quest-review`'s design checkpoint](#review-locally) for an online reviewer. A round is one commit it reviewed; a dismissed review counts as one that approves or requests changes. Only printed when due. |
| `reacted:<content>` | Actor, time, and the PR or review reacted to, as `quest wait` names reactions. |
| `thread` | Node ID, `current` or `outdated`, last commenter, latest comment URL, and `path:line` of each unresolved thread. |
| `signal` | `finding` or `decision`, its URL, who posted it, and its text, for each [signal](#signals-that-hold-a-head) holding the head. |
| `hold` | Label, acquisition token, acquisition time, verified GitHub event API URL, and age; `hold -` when no label holds it. Unknown acquisition facts print as `-` and `unknown age`. |
| `starter-hold` | A draft its starter owns: last activity time, PR URL, and `last active` age. Last activity is not when ownership began. |

The node ID is what GraphQL's `addPullRequestReviewThreadReply` and
`resolveReviewThread` take. Neutral and skipped checks pass. Only each check's
latest run counts, as for GitHub's mergeability: a rerun, or the same workflow
run again on the head, supersedes an earlier run of that name from the same
app and workflow file, and a newer commit status supersedes an older one of its context. A check
that reported `cancelled` also stops counting once a newer GitHub Actions run of
its workflow exists on the head, from any event, as when `cancel-in-progress`
cancels a run whose jobs, such as a matrix job under its unexpanded name, the
newer run never reports; a rerun counts as newer than every run that started
before it. Any other result keeps counting, as does a cancelled run nothing
replaced. Only then does it read the head's workflow runs, which needs Actions
read access. GitHub's own rollup state counts the superseded runs too. A required
check is one branch protection or a ruleset requires for this PR, or a job of a
workflow a ruleset requires. Like `quest wait`, it reads an open PR's
requirements from the base, matches a required check by name and, when the
requirement names one, its app, as GitHub and `quest land` do, and leaves out
`quest land`'s check, which no head carries. `--json` prints the
same facts as one object with the fields `url`, `state`, `draft`, `head`,
`mergeable`, `mergeState`, `reviewDecision`, `autoMerge`, `mergeQueue`,
`landingStopped`, `checks` (`state`, `passed`, `failing`, `pending`), `reviews`, `checkpoints` (`reviewer`, `round`, `url`), `reactions`,
`threads`, `signals` (`kind`, `url`, `author`, `text`), `holds` (`label`, `token`, `takenAt`, `age`, `eventUrl`), and `starterHold` (`lastActive`, `age`, `url`, or null). Ownership uses the state commands' shared reader without changing labels, and event links match the opaque acquisition token against GitHub's event listing. Long lists are paged; reactions are the newest 100 per PR or review,
as in `quest wait`. Any PR state exits 0, invalid arguments exit 2, and other
failures exit 1.

GitHub keeps auto-merge enabled across a writer's push without saying which head
it was enabled on, so the `auto-merge` line reads it from the auto-merge commit
body's `Quest-Land-Head` pin when [`quest land`](#the-watchers-own-queue)
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
`quest:active` label it holds no token for is on the PR; a draft its starter still holds, one without a
`## Waiting` section; and a merged or closed PR, since a push after
the merge brings the branch back. The refusal names the holder's label and
age, never its token, so a refused session is not handed the means to carry
on. That is a prompt to stop, not a lock: `quest status` still shows the token,
for whoever the user asks to release a stale hold. When two
sessions add the label at once, the first added keeps the PR; GitHub records no
event for adding a label already on the PR, so two takes in the same moment
are not told apart.

`quest merge` takes no label: the head-pinned auto-merge or merge-queue entry
it creates is the queue signal, so a queued PR shows no hold. It refuses while
any session holds the PR, so release your own hold first. `--land` needs the full 40-character
head SHA and refuses once the head moves, or while any check on it that
counts in `quest status` failed, required or not, naming each; pending checks do not block.
It also refuses a head that fails `quest check --no-stubs --base <base> --branch
<head branch>`, which it runs on git objects it fetches, so nothing from the
head runs, and ignores findings the base already has; run a `quest` the PR
cannot modify, since the head's own build could skip the check. A base without
quests skips it. While the base requires an approval the PR lacks, such as an
online reviewer's that a ruleset requires (GitHub's review decision is
`review_required` or `changes_requested`), it only arms auto-merge, which waits
for the approval, and refuses where nothing would wait, since an admin's token
would merge or enqueue past the requirement.
It also refuses while a [signal](#signals-that-hold-a-head) holds the head,
naming each.
It enables auto-merge bound to that SHA, or merges at once when nothing is
left to wait for. `--squash` or `--rebase` picks the method, and it refuses one
the repository disallows; otherwise it uses the only method the repository
allows, or else a merge commit, and refuses when merge commits are off and more
than one method remains. On a base that requires the `quest land` check, it
queues the PR for [`quest land`](#the-watchers-own-queue) instead, with
auto-merge in the named method, or else squash, or else any method the
repository and the base's rulesets both allow. That request only signals the
queue; `quest land` applies its own method.
On a base with GitHub's merge queue, which applies its own method, it enqueues
that head, or arms auto-merge bound to it while required checks may still be
pending. The queue builds each PR on the current base, so a head behind it is
enqueued as is. When GitHub refuses to enqueue the head, such as after the
base moved into a conflict, the command fails: fix the PR, for example with
`/quest-iterate`, and land it again.
On a base with neither the `quest land` check nor a merge queue, it refuses
while repository auto-merge is disabled. Follow the repository’s own landing
instructions in CONTRIBUTING.md or AGENTS.md, such as its label queue; never
retry with `--direct` unless the user asks. `--direct` merges such a head at
once, pinned to its SHA, without waiting for pending checks, so wait for them
to pass before landing.
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
passes a merge group only when the group's build, `just check` and `just test`
on the self-hosted runner, passes; it skips on pull requests. `quest land watch` runs the fixer on dropped PRs and
re-enqueues healthy heads at the back of the queue.

The fixer resolves every mechanical cause itself and pushes onto the PR's branch:
conflicts where both sides' intent survives, formatting and lint, generated files,
lockfiles rebuilt from the base's copy, base renames, and build or test failures with
an obvious fix, which it builds and tests with package-registry access. It ignores
instructions in the diff and reads the PR's own CI results as context. It hands back
only what needs a maintainer: a behavior or design decision gets a diagnosis on the
PR, and a fix that edits protected paths or that GitHub refuses to push gets a ready
commit for `quest land apply <pr>`.

## Watch the merge queue with quest land watch

`quest land watch` runs on a maintainer's host, one process per base branch of a repository,
and lands its base through a serial queue: GitHub's merge queue where the
base's rules have a `merge_queue` rule, and otherwise
[its own](#the-watchers-own-queue), as on a private repository on GitHub Team,
which offers no merge queue. Each pass reads the base's rules
(`GET /rules/branches/<base>`) and picks the mode from them, so enabling
GitHub's queue on a repository switches its watcher with no host change; a
pass that cannot read them does nothing. It reads them with a `contents: read`
token, so an installation granted only one mode's permissions runs it. On GitHub's queue it tells each PR the queue
drops unmerged why, and takes a queued or armed PR whose head draws a
[signal](#signals-that-hold-a-head) out of the queue, disarming its auto-merge
and saying why, even one another session holds, since GitHub's queue ignores
hold labels. With `--fixer`, it also runs the land fixer on each PR the
queue dropped for a failure or a conflict, and puts it back at the back of the
queue. It polls; the host needs no public endpoint. Its base is resolved once at
startup, from `--base` or the default branch, so a renamed default branch needs a
restart. Watchers on different bases of one repository, such as `main` and
`release`, run side by side with their own state, locks, clone and `--method`, and
never touch each other's PRs; a second daemon on the same base refuses to start.

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
full log beside it. A push since the removal, a person's removal, a hold, or a
reason the watcher does not know ends the pick, and the comment says the PR
waits for a maintainer to enqueue it again. The state directory remembers each removal
handled, so a restart neither misses nor repeats one; a crash between
commenting and recording finds its own comment's marker and posts nothing. The
first pass reads the ten minutes before it.

GitHub often leaves a PR whose auto-merge is armed out of the queue once it is
ready ([community#209348](https://github.com/orgs/community/discussions/209348)),
as for a pick `quest merge --land` armed while required checks ran. Each pass,
the watcher enqueues every such PR: open, armed, ready (its merge state is
`CLEAN`, `HAS_HOOKS`, or `UNSTABLE`: its required checks passed and it does not
conflict), not lacking an approval its base requires, which auto-merge waits
for, not in the queue, and not added to it since it was armed. It
enqueues only the head auto-merge was armed on, with `expectedHeadOid` bound to
it: GitHub keeps auto-merge across a push, but a push by anyone but the land
fixer ends the pick, and a head it cannot tell yet waits for the next pass. An
armed PR whose required checks fail, or that conflicts, is left alone for
`/quest-iterate` and a new pick. One another session holds waits, armed, until
its hold clears. The watcher's own re-enqueues are among these picks. A refusal
is logged once per pick and retried each pass.

With `--fixer`, the watcher takes each recorded removal, oldest first, while
its PR still waits as the queue dropped it:

- A conflict is first merged with the current base by the quest merge driver,
  in the daemon's private repository. A clean
  merge needs no fixer: the watcher lease-pushes it to the PR branch, records
  it in the PR body's Review, and re-enqueues it.
- Otherwise the [fixer](#the-land-fixer) runs in the background: a
  credential-free wrapper, given the failure log and the PR's number, with the
  dropped head on `pr-<n>`, starting from the base the `merge_group` build
  was built on, or from the current base for a conflict, with the merge's
  conflicts as its log. The log ends with the PR's own checks on the dropped
  head: each check's result, whether it is required, and its URL, then the
  last 20,000 characters of each failing GitHub Actions job's log. At most `--fixer-jobs` (2) run at once; the rest wait
  for a slot. `--fixer-effort` (medium) sets the fixer's
  `model_reasoning_effort`, passed to the wrapper in `QUEST_LAND_FIXER_EFFORT`,
  which `quest land fix --effort` reads by default. Each `--fixer-tag`
  pattern, such as `deploy-*`, fetches the matching tags from GitHub into
  the checkout, pruning those GitHub deleted, so a check that reads them
  runs there as in the queue's build. Each `--fixer-branch` pattern, such
  as `release`, does the same for GitHub's branches, as `origin/<branch>`,
  for a check that diffs against one. The checkout has no remote, so it
  always gets the base it starts from as `origin/<base>`.

Each finished round is recorded in its pick's history: `fixed` for a fixer commit, `merged` for a clean merge,
the cause the fixer named for a failed build it requeued unchanged (`flaky`,
`base` when the base fails it too, or `environment` when the runner does), and
`unchanged` for a conflict it requeued unchanged or a requeue that names no
cause. Its failure signature is the test or step the fixer names, compared
without quoting or repeated whitespace, falling back to the failing job and
step, or, for a conflict, the base it conflicted with. The pick keeps going
while each round makes progress: an `unchanged` round, the failure a fix
addressed recurring right after it, or three unchanged re-enqueues in a row,
whatever their causes, hand it back. A fix is validated, lease-pushed, and recorded in Review, and a push GitHub refuses, or a fix that edits protected paths, is handed
back with its resolution for `quest land apply`, as [the land fixer](#the-land-fixer) describes. The watcher then puts the fixed, merged, or requeued head back
in the queue with `expectedHeadOid` bound to it: it enqueues a head whose
required checks have passed, and arms auto-merge on one whose checks still
run, so GitHub enqueues it once they pass. Either joins the back of the queue.
It comments on the PR with what it did, after any note the fixer wrote. A
handback, from a stop rule, the fixer, a refusal, a crash, or a timeout, is
posted with its reason and a recommendation, and the PR leaves the watcher's
care until a maintainer enqueues it again. A round whose pick ended while it
ran, by a writer's push or enqueue, is not applied, and its comment says so.

The watcher leaves a PR another session holds to that session: one with a hold
label, such as the `quest:active` that `/quest-iterate` takes. It reads the
PR's labels when it handles the removal, before it starts the fixer, and again
before it pushes a result or re-enqueues the PR, so a hold taken while the
fixer runs counts too. A hold ends the pick, as a person's removal does: the
watcher records that first and stops acting on the PR, then posts one comment
saying so, best-effort and never retried. A maintainer enqueues it again once
its session is done. A held flaky-test disable PR is left for a maintainer too.
A round whose collection fails three passes in a row, as when GitHub refuses its
handback comment, is set aside with a logged warning, freeing its fixer slot.

A PR's own CI is a signal, never a gate of its own: only the base's required
checks keep GitHub from enqueuing a head. `/quest-merge` reports the failing
optional checks on the head it picks, and the land fixer reads every check as
context. A public repository may run its checks on pull requests too, since
GitHub's hosted runners are free there; a private one can skip them and rely
on the merge queue's build on the host alone.

The watcher also keeps the repository's flaky tests in `flaky.json` in its
state directory: each flaky verdict, across every PR, by the failure signature
the fixer named, with the `merge_group` jobs that showed it. Only a `flaky`
requeue is a verdict: a failure on the base or from the runner never counts
toward disabling a test. Each failed
build's round is told the tests that flaked before and are not yet disabled, in
`.git/quest-land-flaky.json` in its checkout, which `quest land fix` passes to
the agent, with the follow-up quest path the watcher chose for each when it
first flaked. One verdict alone only re-enqueues the PR, since one judgment could
hide a real bug. When a listed test flakes again, the fixer also commits its
disabling on a `disable` branch from the base: only the skip in the test
framework's own form, naming that follow-up quest. The watcher validates that
commit as it does a fix, against the base's protected paths, refusing any edit under `quest/`, then commits
the follow-up quest on top from a fixed template, `quest/m0/flaky/<name>.md`
in the repository's m0 `flaky` epic, to fix or delete the test, creating the
epic's README when the base has none. It pushes the result to `quest-land/flaky-<sha>`, opens it as a pull
request with its Review recorded, and enqueues it like any other, with no
maintainer's pick. A refused disable waits for the test's next flake, and a
pull request GitHub refuses to enqueue says so and waits for a maintainer.

Without a fixer its token asks for `contents: write`, which disarming a signaled
pull request's auto-merge needs, `pull_requests: write`, `actions: read`, which
the App needs for the logs, and `merge_queues: write`, which
`enqueuePullRequest` needs. With one, which also arms auto-merge and pushes
fixes, it also asks for `checks: read` and `statuses: read`,
for the PR's own checks the fixer reads; a push that carries a workflow change
asks for `workflows: write`.

### The land fixer

The fixer wrapper **must run code as a different user from the App key
owner**, for example inside an nspawn container. Environment filtering cannot
protect the key or later merge tokens from a process running under the
daemon's UID through `/proc`. Host provisioning and isolation belong to the
host; `--fixer` is an executable path, not a shell expression.

The wrapper runs as tracked background work, receiving the full log path
followed by the PR's number, with only `PATH` and `LANG` in its environment.
Its cwd is a standalone repository with no remotes, no alternates, and no link
to the daemon's private bare repository, checked out at `base` so the agent
loads no PR's instructions or tooling, with `batch` and `pr-<n>` branches at
the dropped head beside it. The prompt names the PR's branch and pinned head.
Wrappers must expose only the supplied tree and log, never the state directory
or its private bare repository.
The wrapper starts an ephemeral container and runs `quest land fix <log> <prs...>`
there, exposing that repository read/write and the log read-only at the given paths.
It supplies a fresh HOME, `OPENAI_BASE_URL` (the OpenAI-compatible Responses
endpoint, including `/v1`) and `OPENAI_API_KEY` (the gate's proxy client key).
The daemon never supplies these or any Git/GitHub credential, and the wrapper
must keep every other credential out of the container. Its network must reach the
model proxy and, so the fixer can run the repository's checks on its fix, the
package registries and `github.com`/`codeload.github.com` that the repository's
dependencies come from.
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
beyond an optional `comment`, an optional `blame: true` on a PR that caused the failure (a blamed PR is
fixed or handed back), and on a handback an optional `log: [first, last]` citing the
failure log's lines, which its comment quotes.
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
`## Review`. Forks refusing maintainer edits, refused pushes, invalid results,
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
A resolution too large for the comment hands back plainly.

Every base the watcher merges into a PR head, for a conflict's clean merge or an
own-queue build, drops each `Required`, `Related`, or `Closes` entry linking to
a quest the base deleted since the PR branched, as `quest rm` would have. The PR
wrote that link while the quest was open, so the base finishing it is no fault
of the PR's. A quest the base moved is a rename, not a deletion, and a link in
prose stays.

The App key stays on the host, in `$CREDENTIALS_DIRECTORY/github-app-key` or a
file named by `QUEST_LAND_KEY`, never in argv, where `/proc` would show it. Remote fetches and `ls-remote` use a separate repository-scoped installation
token with exactly `contents: read`, so private repositories are supported. The
read token is refreshed before expiry and retried once on authentication refusal.
Git receives it only through temporary `GIT_CONFIG_*` environment settings, never
in argv or repository configuration. Local `file://` fetches into fixer
repositories remain credential-free. Write installation tokens are scoped to
this repository. Tokens are minted for each push or API merge and passed only
to trusted git and GitHub clients, never the fixer. API tokens stay in the
daemon, refresh before expiry, and are replaced on a 401. Pass errors are
logged and retried with bounded exponential backoff. `flock` prevents two
daemons using the repository (including separate worktrees) or one state
directory; `quest` must be on PATH for the merge driver. Full logs stay in the
state directory: `--state`, or by default systemd's `$STATE_DIRECTORY` or the
XDG state home, in `<owner>-<repo>@<base>`, never inside the checkout. Each
pass deletes a log 7 days after its last write once no job or waiting removal
reads it.

### The watcher's own queue

On a base without GitHub's merge queue, the watcher runs a serial queue of its
own, one build at a time, so a failure is the one PR's with no triage. The
base keeps requiring the `quest land` context nobody reports, with the App as
the ruleset's bypass actor, so GitHub never merges a pick itself and the
watcher is the base's only writer outside an admin's emergency bypass.

Its picks are the open PRs whose auto-merge `quest merge --land` armed, pinned
to their head, in the order they were armed. It ejects, with a comment, a pick
whose head moved since its pin, that lacks a pin, that has a requested change
or unresolved conversations, or whose required check failed. Pins, required
checks, reviews, conversations, rulesets, and classic protection stay
enforced, and protection settings it cannot uphold refuse the queue. The
auto-merge `quest merge --land` enables only signals the queue, so its method
never decides how the watcher lands; `--method` does, and both the
repository's merge settings and a ruleset's allowed merge methods must include
it, and merge commits are refused on a base that requires linear history. A pick still waiting on its required checks or a
required approval keeps its place, and one another session holds waits, armed,
until its hold clears.

For the oldest pick it merges the base into the picked head with the quest
merge driver, in the daemon's private repository, and pushes that merge to
`quest-queue/<base>/<number>`. The repository's queue workflow builds that
branch on push, as it builds a merge group; the header of this repository's
`.github/workflows/queue.yml` shows the trigger. The base's required checks
other than `quest land`, reported on the merge, decide the build: once they
pass, the watcher lands the pick. It lease-pushes the merge to the PR's branch, merges it with GitHub's merge API
pinned to that head, as a squash or, with `--method merge`, a merge commit, and
checks that the landed tree is the tested one, logging `CRITICAL` when it is
not. It lands only on the base it tested: a base that moved during the build
rebuilds the pick there, with no attempt counted.

If the PR branch push is refused, as a fork's is, the watcher instead pushes
the tested commit to the base as a fast-forward, leased on the expected
parent. It comments on the PR with a link to the landed commit and closes it,
so a squashed fork PR shows as closed rather than merged. A merge commit brings
the PR's head into the base, so the watcher first waits about 15 seconds for
GitHub to mark that PR merged, and closes it only if GitHub does not. An
interrupted fallback resumes from its private intent record without repeating
a landed base push. After a merge API refusal, the watcher re-reads
mergeability and briefly retries pending mergeability or a base refresh. It
also retries while GitHub still reports the pin as the head of a PR it just
pushed, or calls the merge it just pushed conflicting. A persistent refusal
ejects the pick as `merge_refused`, a moved head ends it, and a lost merge
response is confirmed from the PR rather than merged again.

The queue branch's push runs the merged PR's own workflow, so a fork can
rewrite any guard that lives there. For a queue workflow on a private runner,
`--refuse-forks` ejects each pick whose head is in a fork, or in a deleted
repository, before its build is pushed, ending a build already under way:
it disarms the PR's auto-merge and comments that fork pull requests cannot use
the private runner, leaving the pick to a maintainer.

A failed build, a build still running after `--timeout` minutes (60), or a
conflict the quest merge driver cannot merge drops the pick as GitHub's queue
removes a PR: the watcher records it for the land fixer in `removal-<n>.json`
with the failing jobs' logs, disarms the PR's auto-merge, and comments with
the failing jobs' tails, and the fixer's rounds, attempts, flaky handling, and
handbacks follow as on GitHub's queue. A re-enqueue arms auto-merge again,
pinned to the head, which puts the PR at the back. A writer's push, a person
disarming auto-merge, or a hold ends a build in progress. The drop is recorded
before any of its steps, so a restart finishes it.

Each pick carries an informational `quest queue` check run, never a required
context: its position, the build in progress with a link to its run, and the
outcome. A queue branch goes, with its unfinished runs cancelled, once its pick
lands or leaves the queue, and the first pass deletes the queue branches an
earlier process left behind. Once the base has GitHub's merge queue, the next
pass ends any build and completes the checks. The ruleset change that adds the
`merge_queue` rule also replaces the required `quest land` context with the
queue workflow's required check, since GitHub's queue never reports
`quest land` and would stall.

The own queue's token asks for `contents: write` and `pull_requests: write`,
to arm and disarm auto-merge and comment, `actions: write` to read logs and
cancel runs, `checks: write` for its check runs, `statuses: read`, and
`administration: read` for the base's classic protection. Its pushes ask for `contents: write`, and `workflows: write` for one that
carries a workflow change.

### Pin bumps

With `--bump`, the watcher keeps the flake input on the watched repository at
the watched base in every other repository the App is installed on, so every
push to the base reaches those repositories with no one touching them.
Installing the App on a repository enrolls it and uninstalling it stops its
bumps; there is no list to keep. Each time the base moves, a pass lists every
installation's repositories, reads each one's `flake.lock` on its default
branch without cloning it, and keeps those that lock the watched repository
through exactly one root input as targets; a repository locking it through
several is reported and skipped. Discovery needs the installations to grant
`contents: read`. It needs `nix` on `PATH`. Once a pass sees the base at a commit a target does
not pin yet, it opens or updates that target's one `quest-bump` PR as the App:

1. It reads the target's `flake.lock` on its default branch for the one root
   input that locks the watched repository on GitHub; a target already at the
   commit gets nothing, and an open bump PR there is closed.
2. In a fresh shallow checkout, which it refuses when a tracked symlink leaves
   the checkout or dangles, since the tools write through symlinks, it drops a
   revision from that input's URL in
   `flake.nix`, so `flake.lock` alone pins it from then on, and locks the input
   at the commit with `nix flake lock --override-input`.
3. It builds the watched repository's `quest` at that commit with `nix build`,
   and runs its `quest init` and `quest check --fix` on the checkout with
   `--root`, from a directory of its own, so the target's `bunfig.toml` never
   loads.
4. It commits the result as moq-bot and lease-pushes it to `quest-bump`. An open
   bump PR's head becomes the new commit's first parent, beside the target's
   base, so the branch never rewinds; any other `quest-bump` branch, left by a
   merged or closed PR, is replaced. Auto-merge on the open PR is disarmed
   before the push. The PR body links the comparison and records the review as
   skipped, since a pin bump changes no repository code and the target's CI is
   the gate.
5. Findings `quest check --fix` cannot resolve leave the PR a draft with a
   `## Waiting` item quoting them. Otherwise it lands like any PR there, through
   `quest merge`'s path: into GitHub's merge queue, the target's own queue, or
   auto-merge. A base that requires no check would merge at once, so there the
   bump first waits for every check and workflow run on its head to pass, and
   for every other app's check suite that ran a check to complete, then merges
   directly
   when the repository has no auto-merge, as on a private repository on GitHub
   Free, whose rules GitHub does not serve. A failed check, or a landing
   `quest merge` refuses, is commented on and left for a maintainer.

From there the target's own gate and fixer take the PR, as any other; a newer
commit on the base replaces it with a fresh bump. `bump.json` in the state
directory records each target's last bump, so a restart repeats nothing and a
closed bump is not reopened for the same commit. A target's failure is logged
and retried on the next pass without holding up the others. Each target gets
its own tokens: `contents: write`, `pull_requests: write`, `merge_queues:
write`, and reads of `actions`, `administration`, `checks`, and `statuses` for its API
calls, and `workflows: write` for a push whose diff from the branch's old head
carries a workflow change. Nix reads GitHub with the watched repository's
`contents: read` token.

### Signals that hold a head

A signal holds a PR's head from landing until it is fixed or answered, since
the review its pick relied on predates it. `quest merge --land` refuses while
one holds, `quest status` lists each as a `signal` line, and a queue takes a
PR that draws one out, ejecting it as `unanswered_signal`, even while it waits
to merge. Nothing waits for a reviewer: a signal the queue reads before the
merge ends the pick. There are two kinds:

- `finding`: an online reviewer's (a bot's, or a review whose body opens
  `Automated review by <name>`) on the head. A review thread it opened holds
  until it is resolved or a writer other than the reviewer replies. A `[P<n>]`
  line in its latest review over the head, counting one that only opens
  threads, holds until a writer's later comment links that review.
- `decision`: a writer's comment that opens with `Maintainer decision`, not in
  a quote or code block, posted after the head's commit, which therefore cannot apply it. A
  newer commit answers it, as does a writer's later comment that links it.

The land fixer's commit reads neither kind, so it answers none: a head the
fixer put back in the queue still counts the findings on every head its pick's
rounds replaced, and the decisions posted since that pick, wherever the queue
judges it (the fixer's re-enqueue, `quest land watch`'s dequeue, and the own queue), however the head got queued. The carry is its own record, written
before the fixer publishes the head and kept through handbacks, holds, removals,
and later picks, so only a writer's push, which moves the head away, ends it.

A writer can push to the repository: an owner, or a member or collaborator
whose permission GitHub reports as write or higher. A bot is never one.

## Gate expensive commands

`quest gate <command> [args...]` holds an expensive command until the host has
room for it, across all of a user's repositories and worktrees:

```sh
quest gate bun run test
quest gate cargo build --release
```

Leave model calls, such as `quest review`, and long-running servers out of the
gate: they wait rather than compute, and a server never exits, so it would hold
its admission forever.

Like every command Quest runs, the gated command gets the environment Quest was
started with. Quest never loads the working directory's `.env` files, as Bun
otherwise would, so a repository's `.env.development` cannot override the
variables a gated build was given.

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

Waiting commands start first come, first served. Each records its place in a
queue when it starts waiting, and counts every command queued ahead of it as
one more recent admission: it starts before them only while the host has room
for all of them, and only the first in line waits out the 5-second spacing. A
command's wait is therefore bounded by the work queued ahead of it, never by
commands that started waiting later. A place is freed once its command starts,
its gate is cancelled, or its gate process exits.

The load limit applies only while a gated command is still running. Otherwise
the load comes from work the gate cannot wait out, so commands start one at a
time as if the raw load had room. A freshly booted hosted macOS runner is one
such host: work outside the job holds its load above its CPU count for the
whole job. Available memory is still required.

A running command's load can lull, as between a build's phases, though it will
soon take the whole host again. So where a systemd scope owns the command, its
gate samples the scope's CPU use every 5 seconds and records the most CPUs the
command kept busy over one sample in the last minute. While gated commands run,
the load counts as at least the sum of those records, and nothing starts while
they kept every CPU busy. macOS, Windows, and Linux without a systemd user
manager have no scope to measure, so the load average alone decides there.

A user's admissions on one host are recorded under
`~/.cache/quest/admissions-v2/<hostname>`, whatever the caller's environment or
login session. A gate judges whether another still runs by its process ID, so
on Linux each PID namespace, such as a sandbox's, keeps a ledger of its own,
named `<hostname>-pid<inode>`, and its gates do not count the host's. A gate
that finds its running admission dropped records it again and warns. The home
directory comes from the user database, not `$HOME`; an account missing from
it, as in arbitrary-UID containers, uses
`/tmp/quest-<uid>/admissions-v2/<hostname>`, and refuses that directory unless
only its UID can write it. `quest agent` keeps its admissions beside them, in
`agents-v2/<hostname>`.

Two kinds of command go ahead of the rest. `quest gate --quick <command>` waits
at most a minute, then starts the command whatever the host's load, memory, and
place in the queue;
pass it only for cheap commands, such as a formatter or `quest check`, that cost
less to run than to hold back. A check that lands PRs goes first: with
`QUEST_GATE_PRIORITY=1` in its environment, every gate inside the check waits
for memory but never for load or the queue, whether or not other gated commands
run, and its command gets `MBX_SCHEDULER_PRIORITY=normal` unless it sets its
own, so [mbx](https://github.com/jdx/mr-boxington), where installed, schedules
its compiles ahead of lower-priority builds. Both kinds of command
record their admissions, so the other callers count them against the host's
headroom. Set the variable where the check starts, such as a merge queue
build's workflow, rather than relying on a slot in
the host's ledger: a container's gates keep a ledger of their own, yet wait on
the host's load. `quest agent` drops the variable, as it drops an admission.

Each admission records the gate's process ID and, except on Windows, when the
gate started, and counts as running until that process exits; a reused process
ID counts as running only on Windows, where it makes a command wait for the
load again. A place in the queue records the same, except that on Windows the
waiting gate refreshes it, and it frees a minute after the last refresh, so a
reused process ID cannot hold the queue. The gate holds no lock while the
command runs, and it owns the
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
  runs the command in its own systemd user scope in `background.slice`, whose
  low CPU weight keeps the desktop session ahead of gated work under contention,
  and owns every descendant, including ones that start their own process group
  or session. Only a process that asks another service manager to start it
  escapes.
  A cancelled gate waits until the scope is empty.
- macOS, and Linux without such a user manager (as in most containers and on
  Ubuntu 22.04), run the command as the leader of a new session and own its
  process group. A descendant that moves to another process group or session,
  as a daemon does, is outside it. The command runs under `nice -n 10`. The session has no controlling terminal: the
  command keeps the terminal as its streams, but cannot open `/dev/tty`, and
  Ctrl-Z suspends only Quest. Nothing reports that a process group emptied, so
  the command gets a pipe on descriptor 3, which every descendant inherits
  unless it or a parent closes it, as Bun and Node do for the processes they
  start. A cancelled gate waits until every process holding it has exited,
  including one outside the group that the signal never reached.
- Windows runs the command under a small Bun stub in a Job Object that kills
  every process left in it once the stub exits, and lets none break away. The
  stub runs at below-normal priority, which everything it starts inherits. It
  owns every descendant, including detached ones, and stops them once the
  command exits or the gate is killed. Windows has no signals to forward:
  Ctrl-C reaches every process on the console, and killing the gate
  terminates the job.

A nested invocation runs immediately inside the admitted command. A gate inside
another Quest scope, such as `quest worktree run`, still runs its command in a
background scope of its own, so only the gated command yields the CPU, not the
rest of the enclosing scope. That scope is bound to the enclosing one, so the
enclosing owner's kill stops it too, and the gate forwards that owner's signals
to it. Internal compiler or test worker parallelism remains
the command's responsibility.

This repository's `just check` and `just test` run through the gate.

Arguments, working directory, environment, terminal streams, and the exit
status pass through, and waiting happens before the command starts. Each
process gets a cancelling signal once from Quest: a nested gate, or one inside
another Quest scope, leaves both the signal and the second signal's kill to
the enclosing owner, which already delivers them to everything it holds. A
signal sent with `kill` to such a gate alone therefore does not reach its
command. Just forwards SIGTERM to the command it runs, so that command gets it
a second time. A gate that Just runs therefore takes one more SIGTERM after a
first one as Just's copy, not as a second signal: a SIGTERM to Just's process
group reaches the gate both directly and through Just. A repeated SIGTERM still
kills, though when sent to Just or the gate alone, or when the two copies
arrive together, it takes a third; a repeated Ctrl-C, which Just does not
forward, kills at the second. There is no timeout except `--quick`'s: any other
command waits its turn for as long as the host stays busy.

### Record each run

A process that starts an agent, such as a job runner or a CPU audit, can read
back what the agent's gated commands waited for by setting `QUEST_GATE_RECORD`
in the agent's environment to an absolute path. Every outermost `quest gate`
run on Linux or macOS, including those the agent's parallel shells and
subagents start, then appends one JSON line to that file, however the run ends:

```json
{"command":["cargo","test"],"directory":"/home/me/src/app","started":"2026-11-12T19:40:01.120Z","admitted":"2026-11-12T19:40:31.452Z","unit":"quest-gate-0d6c3f9e-5a51-4c1b-9d0e-2f4b8a7c6e10.scope","exit":0,"cancelled":false,"error":null}
```

- `started` and `admitted` give the wait. A run cancelled before admission has
  a null `admitted`.
- `unit` is the command's systemd user scope, null where the gate owns it
  another way, such as on macOS. Once the scope ends, systemd logs
  `<unit>: Consumed 1.386s CPU time over 1.357s wall clock time, 8.1M memory
  peak.` to the user journal (`journalctl --user -u <unit>`) at info level when
  the scope used a notable amount, such as a second of CPU, and at debug level
  otherwise. The memory peak needs systemd 255 and Linux 5.19.
- `exit` is the status the gate returns, `cancelled` whether it was cancelled,
  and `error` the gate's own failure, such as a scope it cannot confirm
  stopped.

Each line is one write to a file opened for appending, so concurrent gates
leave only whole lines; give each agent its own file to tell them apart. Nested
gates write nothing, since their command runs inside their outermost gate's.
An unset or empty variable writes nothing, a relative path or a symlink is
refused, and a file the gate cannot open fails it before the command runs. A
new file is readable only by its user. A line it cannot write fails the gate
too, except that a cancelled run exits as it would have without the record.
Windows refuses the variable, since it cannot refuse a symlink atomically.
The agent's own processes write the file, so a record is only as trustworthy
as the agent.

## Route work by size

`quest` ranks the harnesses, models, and efforts that write work of each size,
the same for every repository unless its `AGENTS.md` names others:

| Size | Writer | Fallback |
|---|---|---|
| XS | Claude Code `claude-sonnet-5-5` high | Codex `gpt-6.1-sol` low |
| S | Claude Code `claude-opus-5-5` medium | Codex `gpt-6.1-sol` medium |
| M | Claude Code `claude-opus-5-5` medium | Codex `gpt-6.1-sol` high |
| L | Claude Code `claude-opus-5-5` high | Codex `gpt-6.1-sol` xhigh |
| XL | Claude Code `claude-opus-5-5` xhigh | none |

`quest unblocked --json` lists each ready quest's ranked `models`: its size's
list, or the next size's while a `Maintainer:` item under its `## Waiting`
leaves a decision open, since settling it is part of the work; an XL stays
XL. `/quest-run` starts a quest on the first entry that can run, and falls
to the next only while nothing is written: when the CLI is missing or logged
out, or the agent stops at its usage limit with nothing beyond the claim
commit. Once a model writes, the PR is its own.

A `/quest-iterate` stays on the PR's writer, the model its `## Models`
record's first `Implementer:` line names, so the other model can always
review it. The coordinator dispatching it sizes the work left on the PR, not
the quest's original size, so a merge-and-record iterate on an L quest runs at
XS, and `quest models` prints the entry to run:

```console
$ quest models XS
claude	claude-sonnet-5-5	high
codex	gpt-6.1-sol	low

$ quest models XS --writer claude-opus-5-5
claude	claude-opus-5-5	medium
```

`--writer` prints the size's entry for that model, or else its entry at the
nearest size that lists it, the larger on a tie; a model no list names is an
error. `--json` prints an array of `{harness, model, effort}` objects. The
iterate records the size it was given in its `Implementer:` line, as
`Implementer: Claude Code, claude-opus-5-5, medium effort (iterate, XS)`, so
the model check can audit the routing. `quest review` still reviews the
whole branch at the PR's size.

## Review locally

`quest review` has a model other than the latest writer review the checkout's
committed branch before it is pushed for review, at an effort set by the PR's
size. Each size ranks its reviewers, the same for every repository:

| PR size | Reviewer | When Sol changed it last |
|---|---|---|
| XS | Codex `gpt-6.1-sol` medium | Claude Code `claude-opus-5-5` low |
| S | Codex `gpt-6.1-sol` medium | Claude Code `claude-opus-5-5` low |
| M, or none | Codex `gpt-6.1-sol` high | Claude Code `claude-opus-5-5` medium |
| L | Codex `gpt-6.1-sol` xhigh | Claude Code `claude-opus-5-5` high |
| XL | Codex `gpt-6.1-sol` xhigh | Claude Code `claude-opus-5-5` xhigh |

Beside it, the shadow, the pick's model one effort lower (Sol low for an XS
PR), reviews the same head in its own session, so the routing can be retuned
from what each effort step finds over the one below it. It is skipped when the
pick runs at low or at an `--effort` off the ladder (low, medium, high, xhigh).

It runs on the branch's first run of the pick, then reruns only while it has findings to settle, or once the pick
changed so that it is no longer one step below; its findings are numbered,
answered, and settled like any reviewer's. A pick with no step below it seats
a shadow at its own effort while the old shadow still has findings, so none
is left unanswered. The reviewers run at once;
the first to fail, such as on a usage limit, stops the others, and the round
saves none.

A quest branch takes its quest's size, read from the base branch's tip so a
change cannot lower its own review; any other PR, such as a skill's own, takes
the `Size:` line of the `## Models` record in its open PR's body, and a PR with
neither gets M's reviewers. `--size` overrides both. The first reviewer whose
model is not the latest writer's reviews: the record's last `Implementer:` line
names it, since each session moves its line last whenever it pushes, or
`--exclude-model` names each model to avoid instead. Earlier writers may review.
Without a record, or when its last line names an `unknown` model, the harness
running the command, usually the session that
just pushed, is taken to be the latest writer, so Codex reviews from Claude Code
and Claude Code from Codex. `--harness` names the only reviewer instead of
the pick and the shadow, at its entry's model and effort, and `--model` and `--effort`
override the size pick's or that reviewer's, as a repository whose `AGENTS.md`
names other reviewers needs. A `--harness` run keeps the other
reviewers' sessions for the pick's next run, and refuses while one has
findings to settle, so a head never passes one reviewer alone while the other's
findings are open. When the latest writer changes the size's pick to one with
no session on the branch, its first session settles the open findings of the
reviewer it replaces, and the new pick's shadow settles the old shadow's. An unknown harness, a size whose
every reviewer is avoided, or a missing or logged-out CLI, is an error
rather than a same-model review, as is a login the API rejects mid-round, such
as an expired or revoked token. The reviewer reaches its model as the user's own CLI does:
Claude Code keeps `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, and its
cloud providers' `CLAUDE_CODE_USE_*` switches and settings, so a gateway such
as CLIProxyAPI, Bedrock, Vertex, or Foundry works, and Codex keeps
`CODEX_CA_CERTIFICATE` and sends its requests to `OPENAI_BASE_URL`, if set, as
its `openai_base_url` setting. It uses the CLI's own stored login; the credential the
CLI reads from the environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
`CLAUDE_CODE_OAUTH_TOKEN` for Claude Code, `CODEX_API_KEY` or
`CODEX_ACCESS_TOKEN` for Codex) passes only when the CLI has no stored login or
a gateway or provider is set. A provider's own keys (`ANTHROPIC_AWS_API_KEY`,
`ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`) pass only while a
gateway or provider is set. Variables that would change the reviewer's plugins,
permissions, model, or configuration stay stripped.
A logged-out error names the profile the CLI checked, `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`, or the default when unset, and any gateway or provider.
```sh
quest review                                  # round 1 against origin's default branch
quest review --responses .tmp/responses.md    # round 2: the new head, with fixes and refutations
quest review --base origin/release --new      # a new session against another base
quest review --size S --exclude-model gpt-6.1-sol  # an S PR that Sol wrote, with no record in its body
quest review --branch quest/m1/foo --responses .tmp/responses.md  # a detached checkout of that branch's head
```

Every turn reviews only the branch's own change, from the merge base of `HEAD`
with the base's tip, so a branch behind its base draws no findings on code the
base gained since, which a diff against its tip shows as reverted.
The first round explores the change once. It runs the reviewer's own review,
`codex exec review` with custom instructions or Claude Code's `/code-review
<effort> <merge-base>...HEAD` with text after the target, given the range, the
base's `REVIEW.md`, if any, and any earlier findings and responses up front.
Neither returns a JSON schema itself, so the round resumes that session for one
turn that reads nothing and reports the review in one schema, with a score from
0 to 10 for how ready the head is to land and one sentence on why: 10 lands as
is, 7 to 9 lands after the findings are fixed, 4 to 6 needs rework, and 0 to 3
is the wrong approach. A head with no findings can still score below 10. A
reply without a valid score fails like any malformed reply. Each finding is
high, medium, or low severity; low is anything that would not block landing.
The score informs; the findings and their refutations still decide when the
loop ends. Later rounds take `--responses`, the author's free-text fixes and
refutations, which a round that reported findings requires. A later round
resumes the session and checks only what changed since the last round's head
and its findings when nothing but the head changed: the same model, effort, and
base, a merge base the last round's covers, as when the base moved on, and the
same applicable `AGENTS.md`, `CLAUDE.md`, and `REVIEW.md`. Otherwise it starts a
new session that reviews the whole change and still weighs the responses. A
round that would resume on the head the last round reviewed, when that round
found nothing, runs no reviewer and repeats that round, marked `unchanged`. A refutation stands only when it cites evidence the
reviewer can check. Findings are numbered across the reviewers, in the order
the round printed them. The prompt numbers the last round's findings, and the reply
settles each by its number as fixed, refuted, or still open, with a one-sentence
reason; a reply that skips or repeats one, or keeps more open than it reports,
fails like any malformed reply. A first round's schema has no such list. Each
reviewer settles only its own findings, and gets `--responses` only when it has
some, so on the same head only a reviewer with findings runs. Resuming keeps the
reviewer's prompt cache; Claude Code is asked for its 1-hour cache, and Codex
keeps its default. Each reviewer's session is kept per branch in the clone's
common Git directory, so any worktree of the clone resumes it;
`--new` starts new sessions, but continues each reviewer's tally of its findings
on the branch, less those it drops unsettled, unless the saved state is one
this quest cannot read. `--branch` names the branch instead of the checked-out one, which a
detached `HEAD` requires, such as a checkout of a branch another worktree
holds, so its rounds continue that branch's session.

The reviewer is read-only: Codex in its `read-only` sandbox, ignoring
execpolicy rules, and Claude Code with only read tools and the Bash commands it
judges read-only, in `dontAsk` mode. Its instructions say the base's files and
`REVIEW.md` are all it needs, and that it runs no builds, tests, or `quest`
commands. Codex leaves out its skills catalog; it still loads the user's
`$CODEX_HOME/AGENTS.md`, which no setting skips and a separate home would
split the login, so the reviewer is told to disregard it. Claude Code loads no settings files, so no
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
given at the start of each session, and chooses the review's stance, such as adversarial.

It prints the size and its source, base, and head, then for each reviewer its
harness, model, and effort, session, round,
an `unchanged` line for a repeated round, a `usage` line per turn (input tokens, the part read from the prompt cache, and output), the
finding count, then each finding as its number, severity, `path:line`, and title over its
indented body, then `earlier` with the last round's head and its findings, each
as its number, disposition, severity, `path:line`, and title over its reason; last
come a `record` line and a `next` line. `--json` prints one object with
`rounds`, one per reviewer, `tallies`, every reviewer's findings across the
branch's rounds, `record`, and `next`.

After each round, `quest review` rewrites the `## Review` section of the open PR
from the branch into the base, found among the upstream's PRs from the
repository the base's remote pushes to, and prints `record <url>`. The record
names the reviewed head and the base's short SHA, then for each reviewer its
harness, model, and effort, its Reviewer line ending in `, shadow` for the
shadow, the session and round, the score and rationale, its tally, each finding with
its location, and the last round's findings with their dispositions. The
tally, as `- Rounds: 3; findings 4 (high 1, medium 3): fixed 3, refuted 1, open 0`,
counts the reviewer's rounds on the branch and each finding it raised once,
by its latest severity, however many rounds keep it open. A finding counts
for the reviewer that raised it when a new size pick's reviewer fixes or
refutes it, but one that reviewer keeps open becomes its own, since its round
reports it again. `--new` drops the findings it leaves unsettled from the
tallies. A reviewer the run left out keeps a block with only its session and
tally. `quest status` takes the last full SHA the section names as the
reviewed head, so the head appears in full only once no reviewer reports a
finding, and model text
appears as inline code, which mentions or links nothing and never holds a full
SHA. The section runs to the next level-1 or
level-2 heading, both as Markdown parses them, so an example in a code fence is
text to `quest status` and the record alike; the rest of the body stays as written, and a body without one
gains it at the end, unless it ends inside an unclosed code fence or HTML
comment, which fails the record. With no such PR, or a remote off GitHub, it changes nothing
and prints `record skipped: <why>`. It edits as the user the GitHub token names
(`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`), and `/quest-merge` counts the
record only on a PR whose author has write access, so review your
own PRs with your own token. A record GitHub refuses fails the command after the
round's report, with exit status 1. It exits 0 once the round
finishes, whatever it found, 2 for invalid arguments or a checkout or CLI that
cannot be reviewed, including a login the API rejects, 3 when a reviewer's
account hit its usage limit, and 1 for other failures. A usage limit prints one
line, `error: <harness> hit its usage limit; resets <time>`, where `<time>` is
the reset as an ISO 8601 UTC timestamp, or `unknown` when the CLI named none.
Through a gateway that pools accounts, such as CLIProxyAPI, the limit is the
pool's: Claude Code shows its "All credentials for model ... are cooling down",
and Codex, sent to `OPENAI_BASE_URL`, gives up on the gateway's 429 after its
own retries, which also counts as the limit there.
`/quest-review` runs the rounds and marks the PR ready.

## Audit cost and accuracy

`quest usage` reports `origin`'s PRs updated since `--since` (a local
`YYYY-MM-DD`, by default 7 days ago) and the agent sessions this host, and
each host `--ssh` names, ran since then: which harness, model, and effort
worked on each PR, in which role, at what token cost, and how the work went.

```console
$ quest usage --pr 569
moq-dev/quest, PRs updated and sessions active since 2026-11-06; costs (~$) estimate API list prices

#569 S merged: quest: finish model routing (quest/m0/model-routing/README)
  implementer: Claude Code, claude-opus-5-5, unknown effort
  review: Codex, gpt-6.1-sol, medium effort; round 1, score 10/10; rounds 1, findings 0: fixed 0, refuted 0, open 0
  online review: review (OpenAI), not at the final head; 0 findings: 0 accepted, 0 declined, 0 unclassified, 0 unanswered
  land fixes: codex, gpt-6.1-sol, medium effort
  sessions:
     implementing  local  claude  claude-opus-5-5  low     in 50, cache 36.2k written 1.1M read, out 6.1k, ~$0.63
     reviewing     local  codex   gpt-6.1-sol      medium  in 14.7k, cache 0 written 39.8k read, out 421, ~$0.04
```

[token-max](https://github.com/kixel-ai/token-max)'s `sessions` reads and
prices the sessions, at each model's API list price, which subscriptions do
not bill, so the cost is an estimate. A Claude sub-agent or a Codex review or
spawned thread is a session of its own, so a quest a sub-agent worked on
carries its own cost, not its coordinator's. `quest usage` ties each Claude
Code or Codex session to the PR whose head branch it last names, from the
branches, directory, repositories, and start token-max exports for it, never a
prompt or reply. Since another repository may use the same branch name, the
session must also be this repository's, as the repositories token-max resolved
for it on its own host name, or, once its checkout is deleted, those resolved
there for another session in that exact directory, as a Codex log records
(never a parent's, which a nested clone may not share); otherwise it stays
unattributed. A session on no such branch, such as a sub-agent that never
switched branches, belongs to its parent's PRs, and a coordinator whose
sub-agents worked on several PRs belongs to all of them, its cost counting
equally toward each, so a PR's sessions add up to its whole cost. Each session
gets the record [`quest records sender`](#session-records) would send, and its
role comes from it. Each PR shows its `## Models` size and implementers, and as `unread:` each Implementer line it cannot read; each reviewer the
`quest review` record names, with its latest round and score and its tally of
findings across every round, marked `shadow` for the shadow, where a merged PR whose last round left only low
findings open counts them settled, since `/quest-review` fixes or refutes those
before merge without another round; the land fixer's fixes; the later merged PRs
whose `## Caused by` names it on a bullet that opens with its link, as
`- [owner/repo#N](url) - why`, never a link elsewhere on a line; and each
online reviewer's record, read from GitHub.

An online reviewer is any bot account whose review has a body or opens a
thread, as a reply-only review does not, or a review whose body opens with
`Automated review by <name>`, as a reviewer posting under a person's account
does. It reviewed the final head when one of its reviews with
a body or a new thread is at the PR's last head. Its findings are the review
threads it opens and the `[P<n>]` (or `P<n> —`) lines in its review bodies,
one finding per title across its reviews (a repeated title in one review is
another finding). A finding is accepted, declined, or
unclassified by the first word of its first answer: a reply in its thread, or
for a body finding, a PR comment that links its review or opens with an
accepting word (`Fixed`, `Agreed`, `Applied`, `Right`, `Confirmed`,
`Covered`, `Taken`) or a declining one (`Declined`, `Declining`, `Refuted`,
`Not`). One with no answer counts as accepted when the reviewer settled it, by
a bot resolving its own thread or a later review leaving it out, and as
unanswered otherwise.

Rollups follow: spend by size, role, harness, model, and effort; accuracy
by size and implementer, which sums the tallies but the shadow's, so it counts
every finding the routed reviewers caught before merge, while the shadow's
findings measure an effort step rather than the writer. Since a branch's tallies span every PR from it, only the
PR whose record holds its latest tally, by the most rounds and then the newest,
counts them, and a record written before tallies
counts as unreviewed. An `Implementer:` line's own size, as
`(iterate, XS)`, counts over the PR's; and, over the merged PRs, each online
reviewer's coverage, final heads reviewed, findings per PR reviewed, and
answers. Sessions on no PR here, from any
repository or agent token-max reads, total on an `Unattributed` line. `--pr` and
`--quest` narrow the report to one PR or one quest's branch, and `--json`
prints it as one object. Without `token-max` on `PATH`, it says how to install
it and reports the PRs' records alone. Each PR's `waits:` line sums its
sessions' waits by kind, a shared session's in its share.

`--ssh HOST`, repeatable, also reads that SSH destination's sessions through
the token-max installed there, matching each through the repositories resolved
on its own host. A host that fails fails the report, naming it; drop it from
`--ssh` to report without it. A session found on several hosts, such as a
history copied between them, counts once at its costliest copy, and the report
says how many copies it folded from which hosts. A session with a request
token-max could not price, or a transcript line it could not read or that was
unfinished, is listed under `Lower bounds` with its unreadable lines, and every
cost it reaches reads `or more`. The land fixer's container keeps no session log, so
its fixes show without tokens.

### Session records

When an agent session's turn ends in a checkout that uses Quest, `quest`
sends Kixel Code one record of it, rebuilt each time, so a resend replaces
the last and the store follows the session as it grows. The store keeps the
copy that ends latest, since uploads of one session may arrive out of order. The type is
`SessionRecord`, exported from `quest/core` with `parseRecord` and
`parseUpload`, which refuse a malformed record whole:

```json
{"harness":"claude","session":"7ef44bda-fb9b-436f-9ed8-9013d0f38d46","parent":null,"repository":"acme/app","branch":"quest/m0/login","quest":"quest/m0/login.md","pulls":[42],"role":"implementing","models":[{"model":"claude-opus-5-5","effort":"high","input":230,"cacheWrite":211500,"cacheRead":15800000,"output":88800,"cost":6.64,"complete":true}],"cost":6.64,"complete":true,"start":"2026-11-14T00:06:12.270Z","end":"2026-11-14T00:31:40.120Z","waits":[{"kind":"gate-queue","start":"2026-11-14T00:22:07.386Z","end":"2026-11-14T00:22:07.402Z","until":null}]}
```

- `pulls` are the PRs it worked on, attributed as `quest usage` attributes
  them; a session with none yet, such as planning before its PR opens, keeps
  its `branch`, and the next record names the PR.
- `role` is reviewing when a PR's `## Review` record names it or Codex marks
  it a review, else the one the first quest skill it ran gives: planning
  (`/quest-plan`, `/quest-audit`, `/quest-recurring`, `/quest-import`,
  `/quest-grill`, `/quest-delete`, `/quest-export`), implementing
  (`/quest-start`), iterating (`/quest-iterate`), reviewing (`/quest-review`),
  merging (`/quest-merge`, `/quest-complete`), or coordinating (`/quest-run`,
  `/quest-spawn`). Without one, a sub-agent takes its parent's role unless that
  is coordinating; a session on its sub-agents' PRs only is coordinating; one
  on a `quest-plan/`, `quest-audit/`, `quest-recurring/`, or `quest-import/`
  branch is planning; and the rest are implementing when their first request
  came before the PR opened, else iterating.
- `waits` holds each wait a tool timed: `gate-queue` and `gate-run` for an
  outermost `quest gate`, `pull` for `quest wait` with the first activity it
  printed as `until` (null on timeout), `merge-queue` for a `quest wait` that
  ended on `merged` or `removed_from_merge_queue`, and `person` from a blocking
  question, such as `AskUserQuestion` or `request_user_input`, to its answer.
  `quest gate` and `quest wait` log theirs under
  `$XDG_STATE_HOME/quest/waits` (`~/.local/state`), one file per day kept 90
  days, whenever `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` names the
  session; a Claude sub-agent's commands carry its parent's ID, so a wait goes
  to the one sub-agent of it running then in the wait's directory. Waits may
  overlap, as parallel gates do. `null` means they could not be read, as for a
  session on another host in `quest usage --ssh`, or one whose transcript has
  lines token-max could not read either. Like token costs, waits count only
  those that ended since the window's start.

The record holds no prompt, reply, or transcript text: skills and questions
are read from the transcript on this host, and only their names and times
leave it.

A checkout names its endpoint in a committed `.quest.json`:

```json
{ "records": "https://kixel.example/records" }
```

and each user pairs a token with it in `$XDG_CONFIG_HOME/quest/records.json`
(`~/.config`), so a checkout naming another endpoint, as a hostile branch
might, is never sent the token or a record:

```json
{ "https://kixel.example/records": "token" }
```

The endpoint must be HTTPS, or HTTP to `localhost`. A checkout naming none, or
an endpoint the user holds no token for, sends nothing, and the hook says so
once as a system message.

The `Stop` hook [`quest setup`](#configure-your-agent) installs for Claude Code
and Codex only queues the session under `$XDG_STATE_HOME/quest/records`. One
sender per user, `quest records sender`, sends the queue each minute at low
priority, so a busy host's stops never spend its GitHub quota. Its service
manager runs exactly one, so passes never overlap and a session's uploads reach
the store in order:

```console
$ quest records install
installed and started /home/me/.config/systemd/user/quest-records.service
```

`quest records install` writes a systemd user service on Linux or a launchd
agent on macOS running `quest records sender` with the current `PATH`, and
(re)starts it; rerun it after upgrading `quest`. `quest records uninstall`
removes it. While no sender runs, stops still queue, and the next stop says so
once per outage.

Each pass runs token-max on this host from the earliest queued session's first
instant, reads the PRs updated since then, and posts `{"records": [...]}` with
`Authorization: Bearer <token>`, one upload per endpoint and repository, each
queued session with its sub-agents, which stop without the hook naming them.
A 2xx drops the sessions from the queue, unless the hook queued one again
meanwhile. A 401 or 403 drops them and sends that endpoint nothing more until
the token changes. Any other failure, token-max missing included, keeps them
for the next pass, and the next stop says so once.

### Typed messages

`quest messages` prints the messages a person typed to agents on this host
since `--since` (a local `YYYY-MM-DD`, by default 7 days ago), oldest first,
for a periodic audit of what agents keep getting wrong:

```console
$ quest messages --since 2026-11-10
2026-11-10T17:39:10.552Z claude moq-dev/quest 5f0c2a7e-9d3b-4c1a-8e6f-2b7d4a9c1e03
  quest-spawn
```

Each message shows its time, harness, repository (the checkout's GitHub
`origin`, else its directory), and session, then its text. It also prints each
answer a person gave an agent's blocking question, such as Claude Code's
`AskUserQuestion` or Codex's `request_user_input`, marked `answer` with the
skill the session last ran, then the question, the options the agent marked
`(Recommended)`, and what was picked or typed instead. These come from each
harness's own log, T3 Code's sessions included, since only it keeps the
options. `--json` prints an array of `{kind: "message", time, harness,
repository, session, text}` and `{kind: "answer", time, harness, repository,
session, skill, header, question, options, recommended, picked}`. Besides the
questions answers reply to, it prints no agent reply, tool call or output,
harness reminder, or prompt an agent or scheduler wrote, and tells them apart by the sender each source records, not by
wording. T3 Code records whether a person or an agent created each message, so
the sessions it drives are read from its state (`$T3CODE_HOME`, or `~/.t3`)
and nowhere else. Other Claude Code sessions count the turns Claude Code marks
as a human's, with its reminders dropped and a slash command spelled as typed;
other Codex sessions count the content Codex marks as the user's, outside
headless (`codex exec`) and sub-agent sessions. A log or record in a shape it
does not know fails the command rather than being skipped. Output goes to
stdout only; nothing is stored or posted.

## Headless agents

`quest agent` runs one headless agent turn per call on the agent CLI's own
login, so a session can start the other vendor's agents, which its own
sub-agents cannot run, with one command whose arguments name the whole launch:

```sh
quest agent start --harness claude --model claude-opus-5-5 --effort high --permission-mode auto .worktrees/foo "/quest-start quest/m0/foo.md"
quest agent resume --harness claude --model claude-opus-5-5 --effort high --permission-mode auto .worktrees/foo <session> "Take the recommendation."
quest agent stop .worktrees/foo
quest agent stop --all
quest agent admit
```

`--effort` takes any level the CLI does except `max`, which costs about as much
as a stronger model at a lower effort without matching it; `quest review`
refuses it too.

Codex starts and resumes only in a checkout registered by `quest worktree create`,
on Linux with the `quest worktree run` supervisor available.
Ownership and host support are checked before any agent state is written. Each turn uses
the same lifecycle as `quest worktree run`: restore the reservation before the
turn, then release it and prune declared scratch after the agent and its
remaining descendants exit. Source changes and the session remain available
for resume, including after a decision pause or failed turn. Reinstall or rebuild
pruned dependencies when the next turn needs them. Claude continues to run
directly in the supplied checkout. Codex desktop threads use the desktop app's
native archival instead.

Start and resume first wait until the host can carry one more agent, before
claiming the worktree, and a coordinator runs `quest agent admit` before it
starts or resumes a sub-agent of its own. The host has room while `quest gate`
would admit a command at once, counting every command queued for it and, as one
recent admission each, every agent admitted in the last 5 minutes: an agent adds
no gated load until its first build, and three quarters of those that build at
all reach it by then. An agent `start` or `resume` runs stops counting when it
exits. As in the gate, a host loaded only by work no gate holds still starts one
agent at a time.

Admission only delays the next agent: none already running is paused or
stopped, and `quest agent stop` does not see a launch still waiting, which ends
when its command is cancelled.

Options go before the worktree, and the prompt or message follows it, so text
starting with `-` is never read as an option. The agent runs in the worktree
with the user's environment minus the coordinating session's harness variables
and credentials (keeping `CLAUDE_CONFIG_DIR` and `CODEX_HOME`), secret-manager
tokens, and any `quest gate` admission or priority, so it uses the CLI's stored
login rather than the session's. `--permission-mode` is Claude Code's
permission mode, or Codex's sandbox mode; the agent cannot prompt. Each
repository's running agents are recorded in a user-only directory under
`$XDG_RUNTIME_DIR` (or the temporary directory), which `quest agent stop --all`
deletes after stopping them.

It prints `session <id>` as soon as the id is known, then
`outcome finished|failed|limited|logged-out|stopped`, a blank line, and the
agent's final reply. It exits 0 when the agent finished, 3 when its account hit
a usage limit or ran out of credit, 4 when the CLI is logged out (printing its
login command), 2 for invalid arguments, 128 plus the signal number when
interrupted, and 1 otherwise, so a spawn can skip a harness that cannot run.
`stop` signals the agent and waits until its `start` or `resume` has reported.

The agent CLI runs from its absolute path on `PATH`, skipping relative entries,
so a worktree can never supply its own `claude`. It also runs with only
`PATH`'s absolute entries, so it never finds a program it starts by name, such
as `node`, in the worktree. On native Windows
the lookup tries `PATHEXT`'s program and batch extensions, a batch shim such as
npm's `claude.cmd` runs through System32's `cmd.exe` with its arguments
escaped, `NoDefaultCurrentDirectoryInExePath` stops Windows' implicit search of
the working directory, and `stop` ends the agent's whole process tree at once,
since Windows has no `SIGTERM`.

## Prunable local checkouts

The experimental `quest worktree` commands share one disk budget across this
user's repositories and release a checkout's disk by deleting its declared
scratch in place. They only operate on Git worktrees they create; use the
owning application for Codex or other managed checkouts. Claude Code's
checkouts are Quest's own once you opt into its hooks (see
[Claude Code checkouts](#claude-code-checkouts)).

Set a shared capacity and an explicit reservation in bytes, covering the
checkout, the module stores its submodules clone, and its expected build output. Measure representative jobs before
choosing the budget. Until a capacity is set, only free disk space limits new
reservations. Reservations serialize creators and account for concurrent
expected growth. They do not enforce filesystem quotas against arbitrary
writers, and Git objects stored in the shared repository are not charged; each
checkout's own submodule stores are.

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
left behind. The command gets Quest's environment without Git's
repository-location variables, such as `GIT_DIR` and `GIT_INDEX_FILE`, which a
Git hook would otherwise point at the repository it ran in; `-c` config is kept. When no other run, nor a Claude Code session holding the checkout (see [Claude Code checkouts](#claude-code-checkouts)), remains, it releases it: the
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
ignore, that holds tracked files or another repository or worktree, or that is reached
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

`remove` checks files and commits recursively before deleting a checkout. It refuses while supervised runs are live, and refuses
modified or untracked files and any commit, at `HEAD` or under the checkout's
own refs such as `refs/bisect/`, that no branch or remote-tracking ref
reaches. A squash-merged change leaves its commits unreached, so they count as
preserved only when the GitHub upstream that holds origin's claims has a merged
PR whose head is that commit or descends from it, as when `quest land` merged
the base into the head; other commits need no forge or token. Every ignored
path is build output that removal deletes, declared as scratch or not, except
one holding a nested repository or worktree, which it refuses. Only then does
`git worktree remove` delete the checkout. A checkout already
removed with `git worktree remove` only drops its record, as with `release`.
New checkouts initialize their submodules recursively before returning. Restoring
one preserves its existing submodule pins and local work. Creation verifies any
new module tips not reached by remote-tracking branches (such as SHA-fetched
pins or cloned tags) against origin and records them under
`refs/remotes/quest-pins/`, outside origin's branch-prune namespace. Removal also checks
submodules' files and every module store, including deinitialized ones;
commits at their HEAD or refs must be reachable from a remote-tracking ref,
since module stores and their local branches are deleted with the checkout, and
a module store must have no linked worktrees of its own.
Scratch paths inside submodules use that submodule's ignore rules. Only after
those checks does removal use the force Git requires for submodules.
A failed creation stays charged until its partial checkout is inspected and
removed, then `release` drops its record. Unlock it before removing it; Git
requires `--force` for submodules, so preserve their files and commits first. Records live in
`$QUEST_WORKTREE_HOME`, or `$XDG_STATE_HOME/quest/worktrees` (default
`~/.local/state/quest/worktrees`). The registry lock of a process that exited on
this host is reclaimed; a live lock, or one held from another host, is never
stolen. This initial interface refuses unknown or changed checkout ownership.

### Claude Code checkouts

Quest's worktree hooks for Claude Code are an opt-in each user installs in their
own settings, so they apply in every repository that user opens and no
repository forces them on its contributors:

```sh
quest setup --worktrees
```

It adds `WorktreeCreate`, `WorktreeRemove`, `SubagentStart`, `SubagentStop`,
`SessionStart`, and `SessionEnd` entries running `quest worktree hook` to
[`quest setup`](#configure-claude-code)'s other changes, replacing worktree
entries pasted from an earlier README. Rerun `quest setup` after upgrading to
pick up new events; `--no-worktrees` or `--remove` takes them out.

Only one hook can manage Claude's worktrees, so remove any other
`WorktreeCreate` or `WorktreeRemove` hook first. `quest` must be on the `PATH`
Claude Code runs hooks with: start Claude with `nix develop --command claude`
in a repository whose dev shell provides it, or install it on that `PATH`.
For `claude --bg` and agent view, that is the
environment of the shell that started the session. The hook then creates every worktree Claude makes
in the repository: for `--worktree`, `EnterWorktree`, isolated subagents and
workflow agents, background sessions, and `claude remote-control --spawn
worktree`. Claude no longer copies `.worktreeinclude` files into them.

Each is a `quest worktree` checkout under the main checkout's `.worktrees/`,
named as Claude names it. Like Claude's default, it starts from the remote's
default branch as last fetched (`origin/HEAD`), or from the session's commit
when that is unknown; Claude's `worktree.baseRef` setting no longer applies.
For `--worktree '#123'` or a pull request's URL, Claude names the worktree
`pr-123`, and the hook fetches origin's `refs/pull/123/head` (or GitLab's
`refs/merge-requests/123/head`) into `origin/pr/123` (or `origin/mr/123`) and
starts there, refusing a number origin has both refs for at different commits.
The hook sees only the name, so `--worktree pr-123` gets that request too, and a
number origin has no request for starts from the default base instead of
failing. With only a name to go on,
it declares the main checkout's top-level ignored entries as scratch, except
`.worktrees/`, `.claude/`, and entries holding a nested repository, and
reserves the main checkout's disk usage without `.git` and those checkouts, plus
its submodule stores, which the new checkout clones again.

A subagent's checkout is released when the subagent finishes or stops to wait
for an answer, and restored when it resumes, with a note telling it to
reinstall its scratch. That release keeps `.tmp/`, the guide's workspace, so
the parent can read the reports and logs a stopped subagent left there;
removing the checkout deletes it. Claude names an isolated subagent's worktree for its
agent ID, and a workflow agent's for its workflow run, so the hook binds a
workflow agent's checkout to the first subagent that starts in it, the workflow
agent itself. Another `SubagentStop` hook that keeps a subagent running defeats
this: Claude continues the subagent without a `SubagentStart`, so it works on
without its scratch until it reinstalls it. Quest's own refusal, for a gate the
subagent left running, keeps its checkout instead.

A session's checkout, from `--worktree`, `EnterWorktree`, a background session,
or remote control, is held by the session that created it and by each session
that starts in it, and released the same way once the last of them ends, except
when `/clear` starts a new session in its place. A session that held it restores
it on resuming, as does any session starting in it, with the same note. A background session that sits idle never
ends, so its checkout stays held. Claude Code gives `SessionEnd` hooks at most a
minute, which the entry's `timeout` asks for; a release cut short or failed
leaves the checkout reserved with the failure in `quest worktree status`, until
a session starts in it or `quest worktree release` finishes it.

Claude never removes a subagent's or workflow agent's checkout itself, so
remove a finished one with `quest worktree remove`, which also recovers one
whose session crashed. When Claude removes a session's checkout, through
`ExitWorktree`, leaving a `--worktree` session, or remote control ending a
session whose checkout has no changes, `quest worktree remove` decides: a
checkout holding unpreserved work is kept. `claude rm` never removes one: it
keeps a `claude --bg --worktree` session's checkout, and refuses to remove a
background session whose checkout it entered, saying the worktree is locked by
something else. Don't unlock it; run `quest worktree remove` on the checkout,
then `claude rm` again.

## Work with your agents

Open this repository in Claude Code or Codex. The binary carries the skills;
a repository installs only a stub per skill, so the version you pin decides
what your agents follow. Claude Code's stub inlines `quest skill <name>` when
the skill is invoked; Codex's asks the agent to run it. Either way the skill
arrives with the guide sections and other skills it builds on, in one call:

| Skill | What it does |
| --- | --- |
| `quest-plan` | Ask the questions that turn an idea into scoped quests. |
| `quest-grill` | Settle open decisions through rounds of questions, each with a recommendation. |
| `quest-recurring` | Plan a quest whose finishing PR creates its next occurrence, and what gates it. |
| `quest-import` | Bring open GitHub issues into the planning conversation. |
| `quest-export` | Turn active quests into GitHub issues before leaving Quest. |
| `quest-audit` | Find conflicting, stale, or misprioritized quests, then resolve them. |
| `quest-start` | Claim a ready quest, complete it, and open a PR. |
| `quest-spawn` | Run only `quest-run`'s quest starts: triage ready quests and send agents out in parallel, asking nothing. |
| `quest-iterate` | Iterate on an open PR to settle its open decisions, fix CI and review findings, and push. |
| `quest-review` | Review a PR's branch locally with a model other than its latest writer, then mark it ready for review. |
| `quest-merge` | Queue a PR to land, running `quest-iterate` first when it needs work. |
| `quest-complete` | Run only `quest-run`'s PR decisions and settle what quests and draft PRs wait on you: decide which open PRs to merge, clear resolved waits, queue the merges, then plan the follow-ups no quest owns yet. |
| `quest-run` | Orchestrate a project from one session: start ready quests and take PRs to merge in a loop, until only your decisions remain, then plan the follow-ups no quest owns yet. |
| `quest-afk` | Keep a session such as `quest-run` going while you are away: it acts on its recommendations, defers merges, and walks you through the rest when you return. |
| `quest-delete` | Abandon a quest, deleting it in its own PR. |

Use `/quest-plan` in Claude Code or `$quest-plan` in Codex. Skills coordinate
within your agent session. A started quest stops at a pull request; merging is
a separate invocation, so you review every change.

To use Quest in your own repository, paste this into your agent:

```text
Follow https://github.com/moq-dev/quest/blob/main/SETUP.md to set up Quest here.
```

The [getting started guide](docs/getting-started.md) covers what happens next.

`quest context` prints the rules agents follow in every task, and `quest guide` the
quest format and workflow they read before working on a quest outside a skill;
`quest guide prompting` prints one section.

### Configure your agent

`quest setup` configures your own Claude Code and Codex settings for quest
work, in every repository:

```sh
quest setup
```

It sets Claude Code's `env.BASH_MAX_TIMEOUT_MS` and
`env.BASH_DEFAULT_TIMEOUT_MS` to 3300000, so a foreground command such as
`quest wait` or a gated build runs for up to 55 minutes, just under the 1h
prompt-cache TTL, without the agent passing a timeout or backgrounding it.

It also loads the rules once. The repository's `Quests: ` line has agents run
`quest context` before any work, which costs a turn and is summarized away
when the session compacts. Instead, `quest setup` installs a `SessionStart`
hook (startup, resume, clear, and compact), and for Claude Code a
`SubagentStart` hook, each running `quest hook`, which adds `quest context` to
the session in a repository whose root `AGENTS.md` or `CLAUDE.md` has the
`Quests: ` line, and nothing elsewhere. Codex holds the rules in full, rather
than spilling them to a file, through the hook's `additionalContextLimit`.
`quest setup --worktrees` also installs Claude Code's
[worktree hooks](#claude-code-checkouts).

The rules a program can check are enforced instead of read. A `PreToolUse`
hook on shell commands and file edits denies, with the rule as the reason:

- an edit, commit message, or new GitHub post that adds an em dash outside a
  `>` quote line;
- a `git push` whose refspecs lack a `:`;
- a force-push, `git rebase`, or `git pull --rebase`, unless the command
  starts with `QUEST_USER_ASKED=1` because the user asked for it;
- a new GitHub post (`gh pr create`, `comment`, or `review`, `gh issue create`
  or `comment`, or `gh api` with a `body` field) without a `(Written by ...)`
  line;
- a scratch file written under `/tmp`, outside the checkout, by a redirection,
  `tee`, `mkdir`, `mktemp`, `git clone` or `worktree add`, or a file edit.

For Claude Code, `Stop` and `SubagentStop` hooks refuse to end an agent's turn
while a `quest gate` command it started still runs in the background, naming
each one and telling the agent to block on it: Claude Code stops a subagent's
background commands when it ends, and a session that ends its turn on one
leaves its result unread. A command is the agent's when its transcript holds
the ID Claude Code gave it on backgrounding it, so a sibling's gate does not
hold an agent. Claude Code lists a command only while it runs, so the
refusal ends with the gate. Codex runs no such hook. Once the turn can end,
Claude Code's and Codex's `Stop` hooks queue the session's
[record](#session-records).

`quest` must be on the `PATH` the agent starts with, as for the worktree `--body`, a `body=` field,
`git commit -m`, `--body-file -` with a here-document, or a body file. A file
is read only when its command is the only one on the command line; after
another command, or piped into `gh`, a body passes unread, since it may hold
something else by the time the command runs. `quest context` still prints these rules,
under a last `Checked` section that the hook leaves out, for agents without
it.

`quest` must be on the `PATH` the agent starts with, as for the worktree
hooks. Codex asks you to trust the hooks once, and after each upgrade that
changes them, through `/hooks`; `quest review` runs Codex without your
config, so its reviewers run none of them.

It edits `$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json`, and
`$CODEX_HOME/hooks.json`, or `~/.codex/hooks.json`, when that directory exists.
It keeps your other settings, refuses a malformed file unchanged, writes each
once, and prints each change. Rerun it after upgrading. `quest setup --remove`
takes the hooks out, and each timeout while it still holds Quest's value.

## Where this is going

The first release should let you paste one line into your agent to set Quest up,
bring in existing GitHub issues, work through quests, and leave again without
losing your plans. The binary carries the skills, your tool manager (mise or nix)
pins its version, and your repository's instructions stay yours. Quest supports
macOS, Linux, and [native Windows](docs/windows.md).

[The first milestone](quest/m0/) holds the quests that remain.

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
