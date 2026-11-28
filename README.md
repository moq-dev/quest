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
execution, and merge skills are here. Release binaries are still being
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
git clone https://github.com/kixel-ai/quest.git
cd quest
bun install --frozen-lockfile
bun run build
bun link
```

With Nix, `nix run github:kixel-ai/quest -- --help` builds and runs it instead.
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
[{"path":"quest/m0/export.md","dependents":1,"hosts":[],"arm":"B","cohort":"advisor-2026-11","models":[{"harness":"claude","model":"claude-sonnet-5-5","effort":"high","advisor":"claude-opus-5-5"},{"harness":"claude","model":"claude-opus-5-5","effort":"medium"}]}]
```

Each plain output line contains the count, a tab, and the path. On a terminal,
a heading explains the count. `--json` prints an ordered array, including `[]`
when no quests are ready, and gives each quest the `hosts` its `## Hosts`
section names (empty when it runs anywhere), its writer A/B `arm` and
`cohort`, and the ranked `models` that write it, as [Route work by size](#route-work-by-size)
describes; `--limit <count>`
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

## Park work

Work set aside with nothing scheduled, its plans kept, says so in a `## Parked`
section holding one item that says why and when to resume:

```markdown
## Parked

- until the mesh ships - kept for the fleet demo
```

On a quest, epic, or milestone README, it blocks the document and every quest
under it: `quest unblocked` leaves them out, `quest unblocked <path>` names the
parking, `quest start` refuses them, and `quest waiting` lists none of their
`## Waiting` items, though a draft PR handed back for one is still listed.
Unlike a date, parking never clears on its own; delete the section to unpark.
`quest check` rejects a second item, one opening with a link (a quest the work
waits on goes under `## Required`), and parking the root README.

## Run recurring audits

Quest ships a pack of audits every repository runs once per milestone:

```console
$ quest audit
tree - [M] Audit the quest tree
deps - [M] Audit dependencies
code - [L] Audit the code
cost - [L] Audit build and CI cost
docs - [M] Audit the docs
tests - [M] Audit test coverage
instructions - [XL] Audit agent instructions
```

`tree` finds quests that disagree, conflict, sit in the wrong milestone, or
plan stale work; `deps` reviews new releases, upstream health, held-back
majors, and dependencies worth dropping; `code` deletes dead code, simplifies
overbuilt code, and prunes stale lint suppressions; `cost` weighs each CI job,
gate step, test, build second, and artifact byte against what it earns; `docs`
checks claims, examples, links, and exports against the code; `tests`
finds untested behavior and tests CI never runs; and `instructions` cuts,
consolidates, and rewrites the files agents load against each harness's and
model's official guidance and how agents followed them. `quest audit <name>` prints
what one checks, what each finding becomes, and how its run plans the next
one.

A quest runs an audit by naming it in an `## Audit` section, and holds only
what the repository learned, such as its baseline and the scope it excludes:

```markdown
# [M] Audit dependencies

## Goal

Run the `deps` audit: `quest audit deps` prints what it checks, what each finding becomes, and how to plan its next run.

## Audit

- deps

## Required

- [m0](/quest/m0/README.md) - the audit runs after it
```

`quest init` plants this stub for each audit no quest names, in the milestone
after the lowest one with work left, requiring it, and creates that milestone
when missing; with no work left, the stubs are ready at once. It never edits a
stub afterwards. The run's PR deletes the stub and creates the next one a
milestone later, titled and sized as `quest audit` lists it, scheduled a week out, so improving a definition reaches every
repository on its next run. To opt out, list the audit in the root
`quest/README.md`:

```markdown
## Skipped audits

- deps - this repository vendors nothing and has no package manager
```

`quest check` rejects an audit name Quest does not ship in either section
(unless `--no-stubs`), a
second name in one `## Audit`, and `## Skipped audits` outside the root.

## Find what waits on you

A quest waiting outside the tree says so in a `## Waiting` section, one item
per condition, each opening with who acts and saying what kind of answer it
needs:

- `Maintainer:` with a nested choice list, one bullet marked `(Recommended)`,
  is a **decision**; each bullet is a choice, `label` or `label - description`.
- `Maintainer (action):` is an **action**, a step only the maintainer can take,
  and `Maintainer (PC):` one they can take only at one of their computers, such
  as a local login or a hardware check.
- Every other item, the outside party's such as `moq-dev/moq:` and a
  `Maintainer:` item without a choice list, is **prose**.

`quest check` rejects an item that names nobody, a maintainer qualifier other
than `(action)` or `(PC)`, and a malformed choice list: one outside a plain
`Maintainer:` item, with fewer than two choices, without exactly one
`(Recommended)` ending a label, with an empty or repeated label, or a second
one in the same item. Only that marker makes a nested list a choice list, so
checklists and detail lists stay prose.

```markdown
## Waiting

- Maintainer: which runner builds the Windows suite? GitHub-hosted runners bill per minute, and a self-hosted one needs a machine.
  - GitHub-hosted (Recommended) - no machine to keep up
  - Self-hosted - free minutes, but a Windows host to maintain
- Maintainer (action): open a Hetzner account; `GET /server` on the Robot API answers 200
- Maintainer (PC): plug in the capture card; `v4l2-ctl --list-devices` lists it
- moq-dev/moq: a release carries the VA-API bindings
```

A draft PR hands itself back to the maintainer with the same heading in its
body.

`quest waiting` lists every item from both, the maintainer's first, then by
milestone and the same downstream impact `quest unblocked` counts; a draft
ranks as the quest its branch carries. Each line gives the dependents, whether
the quest is otherwise ready or still blocked, its path or the draft's URL, and
the item with a decision's choices; `--maintainer` keeps only the
maintainer's, `--no-pc` drops the `Maintainer (PC):` ones for a session away
from your computers, and `--json` prints `{path, pr, dependents, ready, waits}`
objects. Each wait is `{line, party, kind, text}`: a decision adds `choices:
[{label, description, recommended}]` and leaves its choice list out of `text`,
and an action adds `pc`. A draft's item that names no party is the
maintainer's prose, warning when it holds a choice list, and since `quest check` never reads PR bodies, a draft's
malformed choice list reads as prose with a warning, keeping `pc: true`
under `Maintainer (PC):` so `--no-pc` still drops it. Drafts come from
the upstream's open PRs, found as for `unblocked --unclaimed`; without the
remote, off GitHub, or when GitHub cannot be read, it lists the tree's items
and warns that drafts were skipped. `/quest-run` walks you through them.

## Claim a quest

`quest start` claims a ready quest so every claim is visible on GitHub:

```sh
quest start quest/m0/export.md
quest start --release quest/m0/export.md
```

It pushes an empty claim commit, built on the upstream default branch, to the
quest's branch (its path without `.md`), then opens a draft PR
from it right away and prints the PR's URL. A checkout on the default branch,
such as the main clone, stays there: a second line prints the directory to
work in, the one matching where it ran, in a worktree on the claim's branch:
the one that already has the branch checked out, else a new one under
`.worktrees/` that `quest worktree` owns. The default branch is the one of the
repository the claim was pushed to, a fork's own. Any
other checkout switches to the claim on a new local branch, or fast-forwards
that branch if it is already checked out. A local branch left from an earlier
attempt is not moved: the claim still succeeds, with a warning to merge the
claim commit into it. A fork pushes to itself and opens the PR on its upstream, found
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

Draft claims are placeholders. This repository's only PR check is the required
`Queue`, skipped on the PR; its `Queue` workflow runs the checks when a reviewed
head enters GitHub's merge queue. Platform verification runs after pushes to
`main` and daily.

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
runs this on the head it lands. A merge queue's build can run it too; its
checkout is detached, so pass the PR's head branch, as this repository's
[`queue-build.yml`](.github/workflows/queue-build.yml) does:
`quest check --base "$BASE" --branch "$head_ref"`.

The check is a floor, not a review: any edit to the quest passes, so reviewers
still judge whether a rewrite matches what remains.

`quest check` also compares the repository's skill stubs with the skills its
binary carries, and reports a missing, outdated, or retired one, and reports
each audit its binary ships that no quest names and `## Skipped audits` does
not list, so an upgrade that adds an audit asks for `quest init`. A job that
checks a PR with a binary built from the base passes `--no-stubs`, since that
binary's skills would reject a PR that changes a stub, and its audit list one
that ships a new audit with its stub; with it, any audit name passes, and the
PR's own binary checks them in its own `quest check`. This repository's merge queue and
`quest merge` do so. It also reads the repository's [`RISK.md`](#risk-tiers),
if any, and reports each `## High` or `## Automatic` item it cannot read,
which would otherwise fail the next `quest review` on a branch from it.

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
quest wait https://github.com/kixel-ai/quest/pull/101 --since 2026-10-07T12:00:00Z --timeout 1800
quest wait 101 --since abcdef0123456789abcdef0123456789abcdef01
```

A number uses the repository's `origin`, so it needs a checkout or `--root`
naming one; a URL works from any directory.
Authentication comes from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.
Every REST read quest makes revalidates its last answer by ETag, kept per token
under `$XDG_CACHE_HOME/quest/github` (`~/.cache`, about 64 MiB), so an
unchanged read costs none of the token's GitHub quota.
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
a cursor, or the given `--since` (else the head SHA, or through Kixel Quest the
time the wait started) if setup had not finished.
Retry with it, not the original command, so activity that landed during the
first wait is still reported.

## Read a pull request's state

`quest status` prints a GitHub PR's current state in one call, such as after
`quest wait` wakes. It accepts the same PR argument and authentication as
`quest wait`, and reports facts without deciding whether the PR is ready, except
that it counts only a review a maintainer's `quest review` run posted to Kixel Quest:

```console
$ quest status 128
url https://github.com/kixel-ai/quest/pull/128
state open
draft false
head 0ade9d977d54c6f48152410532c58e9ea78db3d0
mergeable conflicting
merge-state dirty
review-decision -
review-record diff-identical 5f1c2e9a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e local-review
risk medium diff-identical low It changes when quest gate admits a command.
class -
auto-merge -
merge-queue -
landing-stopped -
checks success passed=14 failing=0 pending=0
review stale commented kixelated 2026-10-16T06:14:04Z https://github.com/kixel-ai/quest/pull/128#pullrequestreview-5543745302
review current commented chatgpt-codex-connector 2026-10-16T17:57:16Z https://github.com/kixel-ai/quest/pull/128#pullrequestreview-5551703054
thread PRRT_kwDOUhuoys6tUUV2 current chatgpt-codex-connector https://github.com/kixel-ai/quest/pull/128#discussion_r4297708263 src/cli/gate.ts:115
hold quest:active LE_example 2026-10-16T17:57:16.000Z https://api.github.com/repos/kixel-ai/quest/issues/events/123456 1 hour ago
```

Each line starts with its record type; any free text, a check name or a path,
comes last, and a missing value prints as `-`:

| Line | Fields |
| --- | --- |
| `url`, `state`, `draft`, `head` | The PR URL; `open`, `closed`, or `merged`; `true` or `false`; the head SHA. |
| `mergeable`, `merge-state`, `review-decision` | GitHub's values, lowercased. |
| `review-record` | Whether the review that counts still covers the head, and the head it reviewed: `current` when it is the head, `diff-identical` when `git diff <base>...<head>` prints the same as for it, or when the head only merged the base since, each merge the clean merge of its parents with quest link-list conflicts resolved as `quest resolve` does (as `quest` reads GitHub; Kixel Quest's read counts only a matching diff until it adopts this check), `stale` otherwise, or `unknown` when the forge cannot compare them, such as a diff too large; then `local-review`, or `no-local-review` for an older run from before every tier ran a local reviewer. The review that counts is the newest passing run [`quest review` posted](#review-locally) to Kixel Quest from someone who can push to the repository, read through Kixel Quest; a run with findings open counts for none. `-` when none counts. Read from GitHub, as with `QUEST_FORGE=github`, it is only a PR body's `## Review` record an earlier `quest review` wrote, with a warning saying so, counted only where a writer's passing `quest review` commit status on the head it names attests it, and `stale`, with a warning, once `RISK.md` at the base's tip is not the file the record names. |
| `risk` | The counted review's [risk tier](#risk-tiers), `low`, `medium`, or `high`; the same state as `review-record`; the tier its classifier set; and the reason. `-` when none counts, and `- malformed -` with why when a body record's risk lines do not parse. |
| `class` | The class, built in or from the base's `RISK.md` `## Automatic` list, the counted review's classifier found the change in, or `-`. |
| `auto-merge` | Method, who enabled it, when, and the head it was enabled on. |
| `merge-queue` | Queue state, position, and when it was enqueued. |
| `landing-stopped` | The reason the latest merge-queue entry, auto-merge, or [`quest land`](#the-watchers-own-queue) queue entry ended (such as `merge_conflict`, `failed_checks`, `unreviewed`, `manual`, `manually_disabled`, or `merged`), who ended it, and when; `-` once the PR has entered the merge queue or auto-merge again since. |
| `checks` | `failure` if any check fails, else `pending` if any is pending or a requirement is unreported, else `success`, and `passed=`, `failing=`, `pending=` counts, all from the checks that count; `-` when the head has no checks and the base requires none. |
| `check` | `failing` or `pending`, `required` or `optional`, the result, details URL, and name. A required check or required workflow nothing reports yet prints as `pending required expected -` with its name, followed by `(from app <id>)` when the requirement names an app, or the workflow's repository and path, as `owner/name:path`. |
| `review` | `current` or `stale` against the head, state, reviewer, time, and URL of each reviewer's latest review. |
| `checkpoint` | Each bot reviewer that approves or requests changes and that the base requires, as a `finding` signal's reviewer is, its round, and its review's URL, when that review is of the head and its latest verdict there, ignoring plain comments, is neither an approval nor a dismissal, at the end of its third, sixth, ... round, where [`/quest-review` stops for the user's decision](#review-locally). A round is one commit it reviewed; a dismissed review counts as one that approves or requests changes. Only printed when due. |
| `reacted:<content>` | Actor, time, and the PR or review reacted to, as `quest wait` names reactions. |
| `thread` | Node ID, `current` or `outdated`, last commenter, latest comment URL, and `path:line` of each unresolved thread. |
| `signal` | `finding` or `decision`, its URL, who posted it, and its text, for each [signal](#signals-that-hold-a-head) holding the head. |
| `hold` | Label, acquisition token, acquisition time, verified GitHub event API URL, and age; `hold -` when no label holds it. Unknown acquisition facts print as `-` and `unknown age`. |
| `starter-hold` | A draft its starter owns: last activity time, PR URL, and `last active` age. Last activity is not when ownership began. |
| `duplicate` | For an open PR, each quest it adds that another open PR also adds, at the same path or under the same title compared without its size, case, or spacing: the quest's path, the other PR's URL, and the other quest's path. A follow-up another PR already owns is dropped, or moved into that PR's quest, before a pick asks about it. |

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
`threads`, `signals` (`kind`, `url`, `author`, `text`), `holds` (`label`, `token`, `takenAt`, `age`, `eventUrl`), `starterHold` (`lastActive`, `age`, `url`, or null), and `duplicates` (`path`, `url`, `other`). Ownership uses the state commands' shared reader without changing labels, and event links match the opaque acquisition token against GitHub's event listing. Long lists are paged; reactions are the newest 100 per PR or review,
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

### Read through Kixel Quest

Agents polling `quest status`, `quest wait`, and `quest unblocked --unclaimed`
can spend a person's whole hourly GitHub quota. Where
[Kixel Quest](https://kixel.quest) serves the repository, those reads, and the
claim and draft reads of `quest start` and `quest waiting`, go to its index of
GitHub's webhooks instead. It serves only hosts signed in with `quest login`:

```console
$ quest login
Upload this host's agent transcripts with its session records? A transcript holds everything a session saw, which can include pasted secrets and file contents, and the maintainers of the repository it worked on can read it. [y/N] n
Open https://kixel.quest/login, sign in with GitHub, and enter the code BCDF-GHJK.
Waiting for its approval; the code expires in 10 minutes.
signed in to https://kixel.quest as workstation; transcript uploads declined
signed git in to https://kixel.quest's repositories: credential.https://kixel.quest/.helper = "", credential.https://kixel.quest/.helper = !quest git-credential
```

Kixel Quest issues the host a token named after its hostname, which `quest`
keeps in `$XDG_CONFIG_HOME/quest/login.json` (`~/.config`), readable only by
the user, with the answer about transcripts, where only a `y` or `yes` agrees;
the record sender uploads no transcripts yet.
Signing in again replaces the host's token.
`quest login` also signs git in to the repositories Kixel Quest hosts, as
`gh auth setup-git` does for GitHub: it writes two `credential.<url>/.helper`
entries to the global git config for that Kixel Quest's URL alone, an empty one
that masks any helper listed before it for that URL, such as `osxkeychain`,
without deleting it, then `!quest git-credential`. That hidden command answers
git with user `quest` and the token in `login.json`, read on every call, so
signing in again rotates it; without a token it names `quest login` and git
fails. Git finds `quest` on `PATH`, so an upgrade keeps working. A helper
listed after quest's, such as a global `credential.helper` defined later in the
file, still runs and may store the token. A global git config quest cannot
write, such as one home-manager manages, fails the command naming both entries,
to declare there instead; one that already holds just them is left alone.
Git matches `<url>/` to the same remotes as `<url>`, but as a key of quest's
own, so a helper the person lists under `<url>` is never moved or removed.
`quest logout` removes those two entries, failing on a config it cannot write
while they are there, then the token from the host; Kixel Quest takes the token
until it is revoked on its Tokens page. `QUEST_KIXEL_URL` must be a bare origin,
since git's credential requests name only the protocol and host. A
`records.json` beside it, where earlier versions read a pasted token, is moved
into `login.json` on the first read, uploading no transcripts.

Without a sign-in, or for a repository Kixel Quest does not serve, reads go to
GitHub as above; the output is the same either way. When Kixel Quest fails, the
command fails too, saying to rerun just that command with `QUEST_FORGE=github`,
which reads GitHub instead. Leave it unset otherwise: it spends the GitHub
quota Kixel Quest spares, and a command run with it while the host is signed in
says so on stderr.
`QUEST_KIXEL_URL` names another Kixel Quest, such as one running locally, which
`quest login` signs in to separately.

A read that must not lag the index, such as `quest pr view`, `quest pr list`,
or the open-PR checks of `quest start`, goes to Kixel Quest's `pulls`, `files`,
or `view`, which answer from GitHub itself and share an answer between callers
until a webhook touches its PR or repository, so these reads draw on Kixel
Quest's installation rather than the person's quota. A 429 means the person has
spent their share of those reads, and fails the command, naming its
`Retry-After`. Writes, such as comments, pushes, and merges, always use the
person's own token, so they are made in their name.

Its read API lives under `/forge`, with the token as a bearer token:
`GET /forge` answers `{"login", "repositories"}`, the person the token names
and the lowercase `owner/repo` of each repository served to them, and
`POST /forge/<read>` takes one of `status`, `pulls`, `updated` (a hosted repository's recently updated PRs, which only Kixel Quest answers), `files`, `held`, `watch`, `view`, or `writers` (a PR's writers, which only Kixel Quest answers) and
answers `{"value", "asOf"}`, the read's value and the time of the newest
webhook behind it. Kixel Quest and a repository's pinned `quest` may each be
newer than the other, so a client ignores answer fields it does not know and
reads a field added since v0.22.0 that an answer lacks as the value permitting
the least, such as no review record counting from a server too old to say
whether a maintainer attested it; a request with a field the server
does not know is refused. A 400 with `{"error"}` refuses a bad argument, such as a
malformed `--since`, which `quest` reports as a usage error. `quest/core` exports each read's types and their parsers;
`quest/github`'s `GitHubForge` answers the same reads from GitHub, other than `updated` and `writers`.
`quest review` posts each run to `POST /reviews` with the same token, its body
`{"runs", "outcomes"}` as `parseReviews` in `quest/core` reads it.

### Work on a repository Kixel Quest hosts

A repository can move off GitHub with Kixel Quest as its whole forge. Its
remote is then a Kixel Quest URL, `https://kixel.quest/<owner>/<repo>.git`,
and its PRs are `https://kixel.quest/<owner>/<repo>/pull/<number>`; that alone
tells `quest` the repository lives there, so every read and write goes to
Kixel Quest, with the token `quest login` stored for it, and never to GitHub;
without one, they fail naming `quest login`. Git's own `clone`, `fetch`, and
`push` there use the same token through the credential helper `quest login`
configures.
`QUEST_FORGE=github` cannot reach such a repository, and a failure there names
no override. `quest start` claims with a draft PR there, `quest iterate`,
`ready`, and `release` take and give back holds that Kixel Quest records rather
than labels, and `quest merge --land <sha>` records a pick of that head, which
Kixel Quest's queue lands by fast-forwarding the base and drops once the head
moves, so it takes no `--squash`, `--rebase`, or `--direct`. `quest review`
records its rounds in the PR body there too.

Where `gh` cannot reach, `quest pr` reads, opens, edits, and comments on PRs
and resolves review threads, with `gh pr`'s flags; it works on GitHub too.
`quest pr view` prints a PR's body, comments, reviews, and every review thread
with its comments, read from the forge itself rather than an index:

```sh
quest pr view 12
quest pr list
quest pr create --title "Plan the forge" --body-file .tmp/body.md --draft
quest pr edit 12 --body-file .tmp/body.md
quest pr comment 12 --thread <thread-id> --body "Fixed in the head."
quest pr resolve 12 <thread-id>
```

`quest pr list` prints a `file <url> <path>` line for each path each open PR
changes, so a search for a path names the PRs changing it, and `--json` prints
`[{"number", "url", "files"}]`; it reads the upstream that holds origin's claims
(a fork's parent), with no 100-file cap, where `gh pr list --json files` stops
at 100. It fails on a PR of 3,000 files or more, GitHub's REST limit, rather
than print a possibly incomplete list.

Its reads are `POST /forge/view` and `POST /forge/files`, answering the same `{"value", "asOf"}`. The
writes are `POST /forge/<write>`, beside the reads: `open`, `close`,
`edit`, `comment`, `resolve`, `hold`, `ready`, `release`, and `pick`, each
answering `{"value", "asOf"}` with `asOf` null. A 409 with `{"error"}` refuses
the write as things stand, such as a PR another session holds, a second open
PR on a claimed quest branch, or a pick of a head that moved, and `quest`
reports it as a refusal; a 400 refuses a malformed argument as a usage error.
`quest/core` exports the `ForgeWrites` interface and each write's types and
parsers, and the CLI's `GitHubWrites` makes the same writes to GitHub.

## Own a pull request

Before a session pushes to an existing PR, it takes the PR, so two agents
never work on one PR at once:

```sh
quest iterate 128            # add quest:active, printing a hold token
quest ready 128 <token>      # drop "Waiting" and mark it ready
quest release 128 <token>    # hand it back
quest merge 128 --land <sha> # auto-merge bound to that head; takes no label
```

`quest ready 128` without a token only marks a draft ready, refusing while any
session holds it, for a draft its starter reviewed without taking a hold.

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
head runs, and ignores findings the base or the head's merge base with it
already has in a list entry or line the head left unchanged, so being behind
the base adds none, while an entry the head edits owns its findings; run a `quest` the PR
cannot modify, since the head's own build could skip the check. A head without
quests skips it when the base or its merge base has none, and one whose quest
documents cannot be read is refused. While the base requires an approval the PR lacks, such as an
online reviewer's that a ruleset requires (GitHub's review decision is
`review_required` or `changes_requested`), it only arms auto-merge, which waits
for the approval, and refuses where nothing would wait, since an admin's token
would merge or enqueue past the requirement.
It also refuses while a [signal](#signals-that-hold-a-head) holds the head,
naming each. A head is high when a `quest review`
status on any of its commits rates it high, or when its change from its merge
base with the base touches a path the base's `RISK.md` holds high, as
[Risk tiers](#risk-tiers) says, or reaches GitHub's 300-file compare limit. A
high head lands only once the newest `quest review` status, by when it was set,
that a user with write access set on that head or on another of the PR's
commits with an identical diff from the base, its target the diff from the head's merge base, passes and
names the base's current `RISK.md`. So any push after the last review that changes the diff, a person's or a
helper's, and any change to the base's `RISK.md` since, waits for a new round.
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
and 1 for other failures. On a repository
[Kixel Quest hosts](#work-on-a-repository-kixel-quest-hosts), they write there
instead.

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
PR, a fix that edits protected paths or that GitHub refuses to push gets a ready
commit for `quest land apply <pr>`, and a high head whose new diff no `quest review`
status covers waits for a review round.

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
  for a slot. `--fixer-effort` (medium) sets the fixer's Claude Code
  effort, passed to the wrapper in `QUEST_LAND_FIXER_EFFORT`,
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
in the queue, unless it is high and no `quest review` status covers its diff, as
`quest merge --land` requires, which hands it back for a review round, marked `unreviewed` in `quest status`. It goes back with `expectedHeadOid` bound to it: it enqueues a head whose
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

Only the base's required checks keep GitHub from enqueuing a head, and
`quest context` asks that pull requests run no checks: the merge queue's build
is the only synchronous gate, and anything slower runs on the default branch.
In a repository that still runs checks on pull requests, `/quest-merge` reports
a failing one on the head it picks, and the land fixer reads every check as
context.

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

Its token asks for `contents: write`, which disarming a signaled pull
request's auto-merge needs, `pull_requests: write`, `actions: read`, which
the App needs for the logs, `merge_queues: write`, which
`enqueuePullRequest` needs, and `checks: read` and `statuses: read`, which
tell a required reviewer's findings from an optional one's and give the fixer
the PR's own checks. With a fixer, which also arms auto-merge and pushes
fixes, a push that carries a workflow change asks for `workflows: write`.

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
It supplies a fresh HOME, `ANTHROPIC_BASE_URL` (the proxy's Anthropic Messages
endpoint, without `/v1`) and `ANTHROPIC_API_KEY` (the gate's proxy client key).
The daemon never supplies these or any Git/GitHub credential, and the wrapper
must keep every other credential out of the container. Its network must reach the
model proxy and, so the fixer can run the repository's checks on its fix, the
package registries and `github.com`/`codeload.github.com` that the repository's
dependencies come from.
The prompt allows only those dependency fetches: no GitHub API, no push, no other
host. The Claude login stays on the proxy.
The wrapper waits for the payload, returns its exit status, and tears down its
container on exit or SIGTERM. A fixer gets 60 minutes from its start. A wrapper
that queues for a shared launcher prints `quest land fixer: admitted <unix-seconds>`
as one line to its output when the launcher admits the job, before any agent
output, so the wait for a slot does not use up the run. Waiting counts against
a total of 120 minutes from the spawn, which is also the deadline of a wrapper
that prints no such line. A wrapper that fails for its own reasons, such as a
launcher refusing the upload, writes its error as a line to file descriptor 3
before it exits nonzero, and passes that descriptor to no payload; with the
payload under another user, as above, no agent or check can forge it. On a
crash, but not a timeout, a signal, or a daemon restart, the handback names the
last such line, redacted and clipped with its summary, and recommends repairing
the wrapper instead of running `/quest-iterate`, as it does when the wrapper is
missing, not executable, or fails to launch. The line stays beside the log as
`<job>.error`. On timeout the daemon sends SIGTERM, allows at
least 10 seconds for container cleanup, then sends SIGKILL on a later collection. The payload defaults
to `claude -p` in bare mode, loading no user or checkout configuration, hooks,
skills, or MCP servers, and limited to the shell and file tools; `--agent <executable>` and repeatable `--agent-arg <argument>`
replace it for another CLI. It writes `<cwd>/quest-land-result.json`: an array of
`{number, action:"requeue", reason}`, `{number, action:"fixed", head, reason}`, or
`{number, action:"handback", diagnosis, recommendation}`, with no extra fields
beyond an optional `comment`, an optional `blame: true` on a PR that caused the failure (a blamed PR is
fixed or handed back), and on a handback an optional `log: [first, last]` citing the
failure log's lines, which its comment quotes.
The payload adds `agent`, `model`, and `effort` metadata to each result: the
model Claude Code's `init` event names, else the `--model <id>` it was given,
else `unknown`.
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
as the bot. A head that takes none of the base's history keeps the protected set as
the pinned head has it, content and mode; one that does merges the whole base the
fixer was given, resolves no conflict in the protected set, not even by keeping the
PR's side, nor one Git's merge names no conflicted file for, such as a directory
rename split, and keeps that set as a plain merge of the base leaves it. It covers
`flake.nix`, `flake.lock`, `shell.nix`, `default.nix`, `nix/`, `.envrc`, `.github/`,
`.gitmodules`, and gitlinks anywhere. A high head gets fixes like any other, but
the watcher puts it back in the queue only when a `quest review` status covers
the new head's diff, as `quest merge --land` requires; otherwise it hands the PR back
for a review round, marked `unreviewed` in `quest status`. The watcher's own merge with the quest merge driver, below, is
no fixer edit: it runs no model and resolves only `quest/` files. Collection copies at most 100 MiB of Git metadata the fixer added into a
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
tree, and prints an unpushed commit and its push command to run after reviewing it;
it records no mechanical fix, so the pushed head needs a review that counts for it,
as `/quest-merge` defines one.
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
directory; `quest` must be on PATH for the merge driver, and `--fixer` refuses to start
with a Git older than 2.39, whose `merge-tree -z` prints free-form messages. Full logs stay in the
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
the watched repository's latest GitHub release in every other repository the
App is installed on, so every release reaches those repositories with no one
touching them, and they run only released code. Before the first release it
bumps nothing.
Installing the App on a repository enrolls it and uninstalling it stops its
bumps; there is no list to keep. Each time the latest release moves, a pass lists every
installation's repositories, reads each one's `flake.lock` on its default
branch without cloning it, and keeps those that lock the watched repository
through exactly one root input as targets; a repository locking it through
several is reported and skipped. Discovery needs the installations to grant
`contents: read`. It needs `nix` on `PATH`. Once a pass sees a latest release whose commit a target does
not pin yet, it opens or updates that target's one `quest-bump` PR as the App:

1. It reads the target's `flake.lock` on its default branch for the one root
   input that locks the watched repository on GitHub; a target already at the
   release's commit gets nothing, and an open bump PR there is closed.
2. In a fresh shallow checkout, which it refuses when a tracked symlink leaves
   the checkout or dangles, since the tools write through symlinks, it drops a
   revision or tag from that input's URL in
   `flake.nix`, so `flake.lock` alone pins it from then on and a later
   `nix flake update` cannot move it, and locks the input at the release's commit with `nix flake lock --override-input`.
3. It builds the watched repository's `quest` at that commit with `nix build`,
   and runs its `quest init` and `quest check --fix` on the checkout with
   `--root`, from a directory of its own, so the target's `bunfig.toml` never
   loads.
4. It commits the result as moq-bot and lease-pushes it to `quest-bump`. An open
   bump PR's head becomes the new commit's first parent, beside the target's
   base, so the branch never rewinds; any other `quest-bump` branch, left by a
   merged or closed PR, is replaced. Auto-merge on the open PR is disarmed
   before the push. The PR body links the comparison and says it lands with
   no review, since a pin bump changes no repository code and the target's CI is
   the gate. Its title and body name the release.
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
release replaces it with a fresh bump. `bump.json` in the state directory
records each target's last bump by the release it moved to, so a restart
repeats nothing, a closed bump is not reopened for the same release, and a pass
that runs before the base's release is tagged leaves that release to the next
pass. A target's failure is logged
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
  `Automated review by <name>`) on the head, when the base requires that
  reviewer: on the commit it reviewed, GitHub reports a check posted by the
  bot account the review came from, a check run from its app or a commit
  status it created, as required for the PR. Every GitHub Actions workflow
  posts as `github-actions[bot]`, so a reviewer posting as that account is
  required wherever any Actions job is, and one posting as its own bot from a
  required workflow is not. A review thread
  it opened holds until it is resolved or a writer other than the reviewer
  replies. A `[P<n>]` line in its latest review over the head, counting one
  that only opens threads, holds until a writer's later comment links that
  review. Any other online reviewer, such as CodeRabbit on a base that
  requires none of its checks, is optional: its findings are suggestions and
  hold nothing. A named reviewer posting under a person's account is never
  required this way. GitHub's own review decision and conversation-resolution
  rule still apply to every reviewer they count.
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

## Gate CPU-heavy commands

`quest gate <command> [args...]` holds a CPU-heavy command until the host has
room for it, across all of a user's repositories and worktrees:

```sh
quest gate bun run test
quest gate cargo build --release
```

Gate a command by the CPU it may use, not by how long it runs. Leave model
calls, such as `quest review`, long-running servers, and quick tools such as
formatters out of the gate: the first two wait rather than compute, a server
never exits, so it would hold its admission forever, and a quick tool would
only wait for room it barely uses.

Like every command Quest runs, the gated command gets the environment Quest was
started with. Quest never loads the working directory's `.env` files, as Bun
otherwise would, so a repository's `.env.development` cannot override the
variables a gated build was given.

Admission is sized from the host, with no configuration. Every platform waits
while the host's CPU load exceeds its CPU count, or while available memory is
below one command's budget: 4 GiB, or a quarter of RAM on smaller hosts, where
RAM is capped by any container memory limit.

On Linux, the load is the CPUs busy over about the last 5 seconds, read from
`/proc/stat`: user, system, interrupt, and steal time count, while idle and I/O
wait do not, so tasks blocked on disk, which the load average counts, leave
their CPUs free for the next command. Busy CPUs cannot show how much more work
waits for them, so a host with less than one CPU idle counts as over its limit.
Gates share their samples beside the admissions ledger, and each running gate
that a systemd scope owns samples every 5 seconds, so a command arriving while
one runs measures at once;
only when no sample is at least a second old does it wait a second for one.
Other platforms use the host-wide 1-minute load average.

On Linux, available memory includes reclaimable host and cgroup file cache and is bounded
by the remaining budget of each enclosing memory cgroup and of the user manager's
`background.slice`, which gated commands run in, so a slice at its `memory.high` or
`memory.max` queues the next command, and a slice's cap below RAM sizes the budget. Load and memory count
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
they kept every CPU busy. Its memory can lull the same way, so on Linux 5.19
or later the gate also records the scope's cgroup, from which every gate reads
the command's peak memory, and available memory counts less what each running
command's peak adds beyond what it holds now, inactive file cache excluded. A
command admitted in the last minute that has a peak takes that, or one budget if
more, instead of a budget on top of it. The peak includes file cache the command
wrote, so a build that writes large artifacts counts at their size too.
Windows and Linux without a systemd user manager have no scope to measure, so
available memory less one budget per recent command decides there, with the
busy CPUs on Linux. macOS counts reclaimable cache as used, so the gate reads no
memory there and the load average alone decides.

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

A check that lands PRs goes ahead of the rest: with `QUEST_GATE_PRIORITY=1` in
its environment, every gate inside the check waits
for memory but never for load or the queue, whether or not other gated commands
run, and its command gets `MBX_SCHEDULER_PRIORITY=normal` unless it sets its
own, so [mbx](https://github.com/jdx/mr-boxington), where installed, schedules
its compiles ahead of lower-priority builds. Its admissions are recorded, so
the other callers count them against the host's headroom. Set the variable where the check starts, such as a merge queue
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
  A cancelled gate waits until the scope is empty. A gate whose scope the user
  manager has not started within 60 seconds fails, naming the scope, and
  cancels its start job; a healthy manager starts one in well under that.
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
forward, kills at the second. There is no timeout: a command waits its turn for as long
as the host stays busy.

### Record each run

A process that starts an agent, such as a job runner or a CPU audit, can read
back what the agent's gated commands waited for by setting `QUEST_GATE_RECORD`
in the agent's environment to an absolute path. Every outermost `quest gate`
run on Linux or macOS, including those the agent's parallel shells and
subagents start, then appends one JSON line to that file, however the run ends:

```json
{"command":["cargo","test"],"directory":"/home/me/src/app","started":"2026-11-12T19:40:01.120Z","admitted":"2026-11-12T19:40:31.452Z","ended":"2026-11-12T19:41:02.810Z","cpu":58210,"unit":"quest-gate-0d6c3f9e-5a51-4c1b-9d0e-2f4b8a7c6e10.scope","exit":0,"cancelled":false,"error":null}
```

- `started`, `admitted`, and `ended` give the wait (`admitted` minus `started`)
  and the wall time (`ended` minus `admitted`). A run cancelled before
  admission has a null `admitted`; `ended` is set however the run ends.
- `cpu` is the CPU milliseconds the command and its descendants used, read from
  its scope's `cpu.stat` as the wait log's is. It is null where the gate owns
  the command only as a process group, such as on macOS, and for a run that
  never ran.
- `unit` is the command's systemd user scope, null where the gate owns it
  another way, such as on macOS. Once the scope ends, systemd logs
  `<unit>: Consumed 1.386s CPU time over 1.357s wall clock time, 8.1M memory
  peak.` to the user journal (`journalctl --user -u <unit>`) at info level when
  the scope used a notable amount, such as a second of CPU, and at debug level
  otherwise. The journal still holds the memory peak, which needs systemd 255
  and Linux 5.19.
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

## Run CI tasks from quest.toml

A repository declares its CI, caching, and release tasks in a root
`quest.toml`, and `quest run` runs the ones a change affects, in place of a
dispatch script of its own. Interactive development recipes stay in the
`justfile`.

```toml
[repo]
merge = "main"                    # the branch PRs merge into; main unless set
release = "release"               # the branch release PRs merge into, if any
cache = ["devShells.default"]     # flake outputs `quest cache push` publishes
invalidate_all = ["flake.lock"]   # a change here runs every task

[tasks.build]
tier = "pr"                       # pr, gate, nightly, release-gate, or release
run = "cargo build --locked"      # a Bash script, run from the repository root
paths = ["rs/", "Cargo.*"]        # run when a change touches one; any change when unset

[tasks.test]
tier = "gate"
run = 'cargo nextest run --profile ci -p "$QUEST_CRATE"'
after = ["build"]                 # starts once build passes, and pulls it in
paths = ["rs/"]
exclude = ["rs/**/*.md"]          # never selects the task
inputs = ["test/vectors/"]        # read outside paths, so selects it too
caches = ["mbx"]                  # shared build caches a runner provisions
os = ["linux", "macos"]           # default: linux and macos, or all three with nix = false
capabilities = ["kvm"]            # what a dispatcher routes the task's host on
environment = { RUST_BACKTRACE = "1" }
cargo = true                      # run once per workspace crate, with QUEST_CRATE set
cache = true                      # reuse a pass for the same inputs; see below for the default
junit = "target/nextest/ci/junit.xml"

[tasks.windows]
tier = "nightly"
run = "cargo build --target x86_64-pc-windows-msvc"
nix = false                       # runs on the host's own tools
os = ["windows"]
```

```sh
quest run                                 # this host's pr tasks the branch affects
quest run --tier gate --fail-fast         # the merge gate
quest run --tier nightly --os macos --all # every nightly task for macOS
quest run --only test                     # one task, whatever its tier
quest run --no-cache                      # run every task, taking no cached pass
quest run --tier gate --query --os linux --os macos   # a runner's matrix
```

`quest run` diffs the working tree, untracked files included, against the
merge base of `HEAD` and a base ref: `--base`, else `$QUEST_LAND_BASE`, else
`origin/` and `[repo] merge`. A task runs when a changed path matches one of
its `paths` or `inputs`, written as [`RISK.md`'s patterns](#risk-tiers) are,
and none of its `exclude` patterns. A change to `quest.toml` itself, or to a
path `invalidate_all` matches, runs every task of the tier. `--all` skips the
diff. A run of `pr`, `gate`, `nightly`, or `release-gate` also runs the tiers
before it, so the gate repeats the PR's checks and a nightly on macOS runs the
Linux gate's tests there; a `release` run runs only `release` tasks, which
publish.

Each task runs through [`quest gate`](#gate-cpu-heavy-commands), so independent
tasks start together and wait only for the host's room. A task that sets
`nix = false` runs on the host's own tools; every other task needs the
repository's `flake.nix`, a regular file, and runs in its dev shell: directly when `quest run`
is already inside it (with no Nix evaluation, unless it uses [the cache](#cached-passes)), and through `nix develop
--command` otherwise. The dev shell says it is the repository's by setting
`QUEST_DEV_SHELL` to the repository's root, as [`quest.lib.mkFlake`'s](#share-flake-boilerplate-with-questlibmkflake) does; a
shell without it, such as another repository's, gets `nix develop` all the
same. That shell may predate an edit to the flake, which the marker, checked as
the shell is entered, cannot tell, so while [the cache](#cached-passes) is in
use `quest run` also needs `QUEST_DEV_SHELL_ID`, which `mkFlake`'s shell sets. A
nested `nix shell` keeps both variables, so a task runs with its tools while
the outer shell's identity still matches. Each task gets `QUEST_TIER`, `QUEST_BASE` (the merge base, unless
`--all`), and its `environment`, exported inside the dev shell, and every line
it prints is prefixed with its name.

A failed task skips the tasks that run after it, while independent ones finish;
`--fail-fast` stops them too. A task that passes must write each `junit` and
`metrics` file it declares, and `metrics` must hold a JSON object; a file left
from an earlier run is deleted before the task starts, and two tasks may declare
the same file, compared without case, only when one runs after the other.
`quest.toml` must be a regular file, not a symlink. `--report <dir>` copies them to `<dir>/<task>/junit.xml`
and `<dir>/<task>/metrics.json` for upload; `<dir>` must not exist yet.

`--query` prints the picked tasks and runs nothing, so a CI runner can plan
its legs before installing a toolchain. Its JSON is one entry per task and
operating system, under `include` for a GitHub Actions matrix:

```json
{"include":[{"task":"test","os":"linux","tier":"gate","after":["build"],"nix":true,"capabilities":["kvm"],"caches":["mbx"]}]}
```

`quest check` validates `quest.toml` beside the quest tree: every key and
value, that each `after` names a task of the same or an earlier tier that runs
on every OS the task does, without a cycle, and the root `flake.nix` below.
`quest/core` exports the parser, `parseQuestManifest`, with no
Node or Nix dependency, so a service such as Kixel Quest can validate a
manifest straight from a git tree.

A `quest.toml` opts the repository into Kixel Quest, which needs Nix, so
`quest check` also requires a regular root `flake.nix`, even when every task
sets `nix = false`, whose `nixConfig` substitutes from Kixel Quest's binary
cache. Nix reads `nixConfig` only from the top of `flake.nix`,
and asks before using it unless the user trusts flake configuration
(`accept-flake-config = true`):

```nix
nixConfig = {
  extra-substituters = [ "https://nix.kixel.quest" ];
};
```

### Cached passes

A task that sets `cache` takes a pass recorded on this host for the same
inputs instead of running, and records each pass it runs. Its summary line
reads `cached (hit) <task>` or `ran <task> (<seconds>)`, and the closing
count says how many passes were cached. A hit writes the reports it recorded
to the task's `junit` and `metrics` paths and under `--report`.

`cache` is on by default for a Nix task, with four exceptions:

- a task that others run `after`, since a cached pass restores none of the
  files it wrote
- a `nightly` task, such as a benchmark or live interop suite, which must
  run again on the same code
- a `release` task, which publishes
- a task declaring `metrics`, which describe the run that wrote them

A task without Nix is never cached, since nothing pins the host's toolchain.
A Nix task runs with the toolchain its digest names, so inside the
repository's dev shell, which may predate an edit to the flake, `quest run`
still runs it directly only if the shell is `quest.lib.mkFlake`'s and built
from the toolchain `nix develop` enters now: the shell's `QUEST_DEV_SHELL_ID`
must equal the identity the same `nix eval` that fingerprints it prints. It
covers everything the repository gave the shell, so an edit to an imported Nix
file moves it. Any other shell, or a stale one, runs each Nix task, and
`cargo metadata`, through `nix develop`. `--no-cache` runs every task and
records nothing.

The digest a pass is recorded under covers:

- the derivation of the shell `nix develop` enters, from `nix eval`, which pins every tool
- the task's `run`, `environment`, and report paths, and the host's OS and CPU
- the digests of the tasks it runs after, since it may read what they wrote
- the Git ids of the files it reads: its `paths` and `inputs`, or every file
  when it declares no `paths`, less `exclude`, plus `invalidate_all`

A modified or untracked file counts as its own bytes, unfiltered, as does a
clean one whose bytes checkout may convert: through a `filter` driver, such as
Git LFS, whose smudge a checkout can skip, a `working-tree-encoding`, or to
CRLF endings by its attributes and `core.autocrlf` or `core.eol`. An untracked nested repository, such as an
agent's worktree, counts as nothing.
A pass is recorded only if the task's inputs are unchanged once it finishes,
so an edit saved while it ran is never filed under the old contents. A task
reading a submodule with uncommitted changes runs uncached, as do the tasks
after it.

The digest leaves out `QUEST_TIER` and `QUEST_BASE`, so a pass holds across
tiers and rebases; a task whose outcome depends on either sets `cache = false`.

A task with `cargo = true` runs once per crate of the Cargo workspace at the
repository root, one crate at a time, with `QUEST_CRATE` naming it, such as
`cargo nextest run -p "$QUEST_CRATE"`. Its output and reports carry
`<task>:<crate>`, and `--report` copies them to `<dir>/<task>/<crate>/`.
`quest run` reads the workspace with `cargo metadata --locked
--all-features`, so a stale `Cargo.lock` fails the run and optional
dependencies count. Each crate's digest reads:

- its own directory, and those of the path crates it depends on, without
  their dev-dependencies
- the registry and git packages they resolve to, with their features
- the root `Cargo.toml`, with only the `[workspace.dependencies]` entries its closure uses
- `.cargo/config.toml`, `rust-toolchain.toml`, and `.config/nextest.toml`
- files outside the member crates that the task's `paths` select
- the commit of a submodule holding any of those crates
- the task's `inputs`

A crate whose closure declares a path crate that `cargo metadata` lists
nowhere, such as an optional one only a task's `--features` enables on a
crate outside the workspace, runs uncached.

Editing crate B or bumping its dependency leaves crate A's pass in place
unless A depends on B.

Passes live in `$XDG_CACHE_HOME/quest/tasks`, or `~/.cache/quest/tasks`, at
most 256 MiB, least recently used first out. A cached pass is trusted as if
the task ran, so the cache is trusted only as far as the user account that
holds it, and `quest run` refuses a directory another user owns or can write.
A host's merge queue keeps its passes under its runner's own user, and runs
`--no-cache` when that user also runs code no one reviewed.

## Share flake boilerplate with quest.lib.mkFlake

`quest.lib.mkFlake` builds a repository's per-system flake outputs, so its
`flake.nix` pins only `nixpkgs` and `quest`:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    quest = {
      url = "github:kixel-ai/quest";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, quest }:
    quest.lib.mkFlake {
      inherit self nixpkgs;
      # A treefmt-nix module; nixfmt is on unless it sets programs.nixfmt.enable = false.
      fmt.programs.rustfmt.enable = true;
      perSystem =
        { pkgs, system }:
        {
          shell.packages = [ pkgs.cargo pkgs.just ];  # pkgs.mkShell's arguments
          packages.default = pkgs.callPackage ./package.nix { };
        };
    };
}
```

It adds to what `perSystem` returns, for each of `systems` (`x86_64-linux`,
`aarch64-linux`, and `aarch64-darwin` unless set), with nixpkgs imported with
`overlays`:

- `devShells.default`, `pkgs.mkShell` called with `shell`, holding `quest`
  and the repository's `treefmt`. It sets `QUEST_DEV_SHELL` to the nearest
  directory up holding `flake.nix` when that `flake.nix` and its `flake.lock`
  are the ones the shell was built from, so `quest run` and `quest fmt` run
  there without entering the shell again, and a shell entered from another
  checkout names none. It checks them only as the shell is entered. It also
  sets `QUEST_DEV_SHELL_ID` to an identity of everything `shell` holds, which
  `quest run` compares with the identity `nix develop` would enter now before
  it runs cached Nix tasks directly. `perSystem`'s `quest` replaces the `quest`
  package.
- `formatter`, the same `treefmt`, which `nix fmt` runs.
- `checks.quest`, which runs `quest check`, `quest.toml` and `nixConfig`
  included, on the flake's source; a `checks` entry of the same name replaces
  it.

`devShells.default` and `formatter` are always these; `perSystem` adds other
shells and outputs.

`treefmt-nix` builds `treefmt` inside Quest's flake, so `fmt` takes any of its
[`programs`](https://github.com/numtide/treefmt-nix) and `settings` with no
input of the repository's own.

```sh
quest fmt                        # format the repository
quest fmt --fail-on-change src/  # treefmt's own arguments
```

`quest fmt` passes every argument after `fmt` on, `--help` and `--root`
included (`quest help fmt` prints its own help, and Quest's `--root` goes
before `fmt`), and runs that `treefmt`, which finds the repository
root itself and reads paths from the current directory: directly inside the dev shell, with
no Nix evaluation, and through `nix develop --command` outside it. A
`[tasks.fmt]` in `quest.toml` replaces it: `quest fmt` runs the task's `run`
script from the repository root, with its `environment`, the arguments as
`$1` onward, and the dev shell unless it sets `nix = false`.

## Route work by size

`quest` ranks the harnesses, models, and efforts that write work of each size,
the same for every repository unless its `AGENTS.md` names others. Only
Claude Code writes, and a quest whose writer is at its usage limit waits for
it:

| Size | Writer |
|---|---|
| XS | Claude Code `claude-sonnet-5-5` high |
| S | Claude Code `claude-opus-5-5` medium |
| M | Claude Code `claude-opus-5-5` high |
| L | Claude Code `claude-opus-5-5` high |
| XL | Claude Code `claude-opus-5-5` xhigh |

`quest unblocked --json` lists each ready quest's ranked `models`: its size's
list, or the next size's while a `Maintainer:` item under its `## Waiting`,
other than an action, leaves a decision open, since settling it is part of the work; an XL stays
XL. `/quest-run` starts a quest on the first entry that can run, and falls
to the next only while nothing is written: when the CLI is missing or logged
out, or the agent stops at its usage limit with nothing beyond the claim
commit. Once a model writes, the PR is its own.

While the writer A/B runs, every size's quests split 50/50 between two arms,
to measure whether Claude Code's advisor tool, a stronger model the writer
consults mid-task, pays for itself: arm A runs the table's writer, and arm B
pairs a writer with an advisor.

| Size | Arm B |
|---|---|
| XS | `claude-sonnet-5-5` high, advised by `claude-opus-5-5` |
| S | `claude-sonnet-5-5` high, advised by `claude-opus-5-5` |
| M | `claude-sonnet-5-5` high, advised by `claude-opus-5-5` |
| L | `claude-opus-5-5` high, advised by `claude-fable-5-2` |
| XL | `claude-opus-5-5` xhigh, advised by `claude-fable-5-2` |

A hash of the quest's path picks the arm, so a restart or respawn keeps it;
`quest unblocked --json` names it as `arm`, `A` or `B`, with the A/B's
`cohort`, `advisor-2026-11`, and puts its entry first in `models`, an advised
entry naming its `advisor`. Arm B falls to the size's own writer when its entry
cannot run. A quest with a `Maintainer:` decision open runs no arm, since it
runs the next size's list, so an arm always runs at its PR's size; its `arm`
and `cohort` are `null`. An entry with an advisor runs through
`quest agent --advisor`, since no native sub-agent takes one. The agent that
runs the arm's entry ends its `Implementer:` line with the arm, cohort, and advisor, as
`Implementer: Claude Code, claude-sonnet-5-5, high effort (arm B, cohort advisor-2026-11, advisor claude-opus-5-5)`,
so the readout never mixes this cohort's PRs with an earlier A/B's.

A `/quest-iterate` stays on the PR's writer, the model its `## Models`
record's first `Implementer:` line names, so the other model can always
review it. The coordinator dispatching it sizes the work left on the PR, not
the quest's original size, so a merge-and-record iterate on an L quest runs at
XS, and `quest models` prints the entry to run:

```console
$ quest models XS
claude	claude-sonnet-5-5	high

$ quest models XS --writer claude-opus-5-5
claude	claude-opus-5-5	medium
```

`--writer` prints the size's entry for that model, or else its entry at the
nearest size that lists it, the larger on a tie. A model no list names, such
as Codex's, is an error, and the coordinator then starts the iterate on its
size's first entry that can run. An iterate on a PR whose first
`Implementer:` line names an arm runs the model, effort, and advisor that line
records instead, even after the PR is resized, and records it as
`(iterate, XS, arm B, cohort advisor-2026-11, advisor claude-opus-5-5)`. An
effort the line leaves out comes from the arm's entry at the PR's size, as
`quest models S --arm B --cohort advisor-2026-11` prints, while that size and
cohort run the arm; `--arm` refuses an ended cohort.
Plain output adds the advisor as a fourth column for an entry that pairs one,
and `--json` prints an array of `{harness, model, effort, advisor?}` objects. The
iterate records the size it was given in its `Implementer:` line, as
`Implementer: Claude Code, claude-opus-5-5, medium effort (iterate, XS)`, so
the model check can audit the routing. `quest review` still reviews the
whole branch at the PR's size.

## Review locally

`quest review` has a model no weaker than the latest writer review the checkout's
committed and pushed branch before it is marked ready for review, picking seats
and effort from a 7-rung `(size + risk)` ladder (`XS=0`…`XL=4` plus `low=0`,
`medium=1`, `high=2`). It needs Git 2.41 or later, whose `--attr-source` keeps a head's
`.gitattributes` from hiding its hunks from the risk classifier and the diffs it writes for
reviewers, and is a usage error
before it; `--accept` runs no diff and is exempt. Every rung lists the same two
models, the same for every repository:

| Rung | `(size, risk)` | Seats | Pick | Fallback (rungs 0–2) or second seat (rungs 3–6) |
|---|---|---|---|---|
| 0 | `XS low` | 1 | Codex `gpt-6.2-sol` medium | Claude Code `claude-opus-5-5` medium |
| 1 | `XS medium`, `S low` | 1 | Codex `gpt-6.2-sol` high | Claude Code `claude-opus-5-5` medium |
| 2 | `XS high`, `S medium`, `M low` | 1 | Codex `gpt-6.2-sol` xhigh | Claude Code `claude-opus-5-5` high |
| 3 | `S high`, `M medium`, `L low` | 2 | Codex `gpt-6.2-sol` xhigh | Claude Code `claude-opus-5-5` medium |
| 4 | `M high`, `L medium`, `XL low` | 2 | Codex `gpt-6.2-sol` xhigh | Claude Code `claude-opus-5-5` high |
| 5 | `L high`, `XL medium` | 2 | Codex `gpt-6.2-sol` xhigh | Claude Code `claude-opus-5-5` high |
| 6 | `XL high` | 2 | Codex `gpt-6.2-sol` xhigh | Claude Code `claude-opus-5-5` xhigh |

A model may review its own work, in a session of its own, so the writer's model
is never skipped for that alone. Every `low` PR runs a local review.

A `quest` run from the source of the checkout it judges (`bun src/cli/bin.ts`, or
a build made there) is that PR's own build, which never records its own review:
the round runs, but posts nothing and sets no `quest review`
status, and prints `record skipped:` telling you to rerun with an installed
`quest`. `quest merge` run that way refuses.

The reviewers run at once;
the first to fail, such as on a usage limit, stops the others, and the round
saves none.

On a one-seat rung (rungs `0`–`2`), a reviewer that cannot run passes the round
to the next eligible one, so Opus reviews while Sol is out; on a two-seat rung
(rungs `3`–`6`), both seats are required, so either being unavailable fails as
an outage (exit 3). That is a failure the CLI or provider reports before any finding is
saved, never text in the diff or a reply: a CLI that is not installed, logged
out, or has its login rejected, or sent to a gateway with no credential,
passes over every model of that CLI, and a
model at its usage limit passes over only itself. The run prints a `skipped`
line for each reviewer it passed over, such as
`skipped codex gpt-6.2-sol high usage limit, resets 2026-11-18T03:00:00Z`.

The new reviewer settles the open findings of the one it replaces. When no
eligible reviewer is left (or either required reviewer on a two-seat rung is
out), the run fails, exiting 3 with each one's error. A reviewer `--harness`,
`--model`, or `--effort` names never passes the round on.

A quest branch takes its quest's size, read from the base branch's tip so a
change cannot lower its own review; any other PR, such as a skill's own, takes
the `Size:` line of the `## Models` record in its open PR's body, and a PR with
neither gets M's reviewers. `--size` overrides both. The first reviewer whose
model is not weaker than the latest writer's reviews, which may be the writer's
own model: only Sonnet is weaker, than every other model, so no list names
it. The record's last `Implementer:` line
names the latest writer, since each session moves its line last whenever it pushes, or
`--exclude-model` names each model to avoid instead, with every model weaker
than it. Without a record, or when its last line names an `unknown` model,
none is avoided, so the never-weaker rule needs the record. `--harness` names the only reviewer instead of
the rung's seats, at the model and effort of its first entry whose model is not avoided, and
`--model` and `--effort` override the rung pick's or that reviewer's, as a
repository whose `AGENTS.md` names other reviewers needs; a `--model` the list
names, in any spelling such as `openai/gpt-6.2-sol`, runs on its own entry's
harness and effort, passed to the CLI as given, and one it does not at
`--harness`'s first entry. `--exclude-model`, records, and `quest usage` match
a listed model by any spelling too. A `--harness` run keeps the other
reviewers' sessions for the pick's next run, and refuses while one has
findings to settle, so a head never passes one reviewer alone while the other's
findings are open. When the latest writer changes the rung's pick to one with
no session on the branch, its first session settles the open findings of the
reviewer it replaces. A rung whose every reviewer is avoided is an error. The reviewer reaches its model as the user's own CLI does:
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
gateway or provider is set. Claude Code never sends its stored login to a
gateway: with `ANTHROPIC_BASE_URL` set and no cloud provider, it needs
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `Authorization` header in
`ANTHROPIC_CUSTOM_HEADERS`, else it cannot run. Nor does Codex: with
`OPENAI_BASE_URL` set, it needs `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN`, and
skips its login check, which never asks the gateway. Under
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, as in a T3 Code session, `quest review` drops every
Claude Code gateway, provider, and credential in the environment, since the
host set them, and reviews on the stored login.
Variables that would change the reviewer's plugins,
permissions, model, or configuration stay stripped.
A logged-out error names the profile the CLI checked, `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`, or the default when unset, and any gateway or provider.
```sh
quest review                                  # round 1 against origin's default branch
quest review --responses .tmp/responses.md    # round 2: the new head, with fixes and refutations
quest review --base origin/release --new      # a new session against another base
quest review --size S --exclude-model gpt-6.2-sol  # an S PR, with no record in its body, that Sol must not review
quest review --branch quest/m1/foo --responses .tmp/responses.md  # a detached checkout of that branch's head
```

Every turn reviews only the branch's own change, from the merge base of `HEAD`
with the base's tip, so a branch behind its base draws no findings on code the
base gained since, which a diff against its tip shows as reverted.
The first round explores the change once. It runs the reviewer's own review,
`codex exec review` with custom instructions or Claude Code's `/code-review
<effort> <merge-base>...HEAD` with text after the target, given the range and a file
of its diff, written with flags that keep the checkout's config and the head's
`.gitmodules` and `.gitattributes` from hiding a change, Quest's shared
review rules (`assets/REVIEW.md`), the base's `REVIEW.md`, if any (which adds to
them and takes precedence), and any earlier findings and responses up front. It
also asks the reviewer to name each contract the change alters and search past
the diff for the dependents left on the old one. None returns a JSON schema
itself, so the round resumes that session for one turn that reads nothing and
reports the review in one schema, with a score from 0 to 10 for how ready the
head is to land and one sentence on why: 10 lands as is, 7 to 9 lands after the
findings are fixed, 4 to 6 needs rework, and 0 to 3 is the wrong approach.
Notes never lower the score. A reply without a valid score fails like any
malformed reply. Each finding is high, medium, or low severity, and its body
ends with the fix the reviewer recommends. A high or medium finding holds the
head until a round settles it or the maintainer accepts it. A low one is a
note, printed and recorded for the author to take or leave, never numbered,
answered, or carried to a later round, so a round with only notes passes the
head. A reviewer that would
build the change another way reports that approach as its recommendation, which
informs the author's choice but holds nothing. The score informs; the findings
and their refutations still decide when the loop ends. Later rounds take
`--responses`, the author's free-text fixes and refutations, which a round that
reported findings requires. From a reviewer's third round on, a round that
still reports findings prints `next decide`: the author stops, and the user
picks fixing them as recommended, accepting them, or dropping the PR. Every
prompt lists the findings the branch settled without a fix, those refuted and
those the maintainer accepted, with their reasons, so no reviewer reports them
again; `--new` keeps that list. A later round resumes the session and checks only
what changed since the last round's head and its findings when nothing but the
head changed: the same model, effort, and base, a merge base the last round's
covers, as when the base moved on, the same applicable `AGENTS.md`,
`CLAUDE.md`, shipped shared review rules, and `REVIEW.md`, and the last round's
head still in the clone, which an amend and a prune can remove. Otherwise it
starts a new session that reviews
the whole change and still weighs the responses. A round that would resume on
the head the last round reviewed, when that round found nothing, runs no
reviewer and repeats that round, marked `unchanged`. A refutation stands only
when it cites evidence the reviewer can check. Findings are numbered across the
reviewers, in the order the round printed them. The prompt numbers the last
round's findings, and the reply settles each by its number as fixed, refuted,
or still open, with a one-sentence reason; a reply that skips or repeats one,
or keeps more open than it reports, fails like any malformed reply. A first
round's schema has no such list. Each reviewer settles only its own findings,
and gets `--responses` only when it has some, so on the same head only a
reviewer with findings runs. Resuming keeps the reviewer's prompt cache; Claude
Code is asked for its 1-hour cache, and Codex keeps its default. Each
reviewer's session is kept per branch in the clone's common Git directory, so
any worktree of the clone resumes it; `--new` starts new sessions, but
continues each reviewer's tally of its findings on the branch, less those it
drops unsettled, unless the saved state is one this quest cannot read.
`--branch` names the branch instead of the checked-out one, which a detached
`HEAD` requires, such as a checkout of a branch another worktree holds, so its
rounds continue that branch's session.

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
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `CODEX_API_KEY`. It spends real usage, so CI never
runs it; run it after upgrading any of the CLIs. The base is fetched first, since
the sandbox has no network. The reviewer follows the base's `AGENTS.md` and `CLAUDE.md`, at the
root and in each directory holding a changed path, never the checkout's, so a
change cannot instruct its own reviewer. Quest's shared review rules always come first and set the default adversarial
stance; the base's `REVIEW.md` is optional, adds repo-specific rules, and takes
precedence where they conflict.

It prints the size and its source, base, and head; the head's `risk` tier and
reason, then `classified` with the classifier's tier, how it was set (`model`
or `paths`), and reason, and for a model a `classifier` line with its
harness, model, effort, and session, and its `usage` line; then for each reviewer its
harness, model, and effort, session, round,
an `unchanged` line for a repeated round, or an `accepted` line for a round `--accept` repeats, a `usage` line per turn (input tokens, the part read from the prompt cache, and output),
the score, a `recommendation` line when the reviewer would build it another way, the
finding count, then each finding as its number, severity, `path:line`, and title over its
indented body, then `notes` and each note as `- path:line title` over its body, then `earlier` with the last round's head and its findings, each
as its number, disposition, severity, `path:line`, and title over its reason; last
come a `record` line and a `next` line. `--json` prints one object with
`rounds`, one per reviewer, `tallies`, every reviewer's findings across the
branch's rounds, `risk`, the head's tier with its classification, `skipped`,
`accepted`, the maintainer's reason under `--accept` or null, `record`, and
`next`.

Every run that records needs the host signed in to Kixel Quest with
[`quest login`](#read-through-kixel-quest), and Kixel Quest serving the
repository of the branch's open PR, since it stores no post for one it does
not: both are checked before any reviewer runs.
After each run, `quest review` finds the open PR from the branch into the base,
among the upstream's PRs: the one from the repository the base's remote pushes
to, else the only one from another repository whose pushed head the
checked-out `HEAD` contains, as in a maintainer's checkout of a contributor's
fork PR. On GitHub it first sets the `quest review` commit status on the head,
on the GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`), so push
the head first: `failure`, which a run with no finding open sets to `success`
only once the post below is stored, so a failed post leaves the head failing, described
by the head's risk tier, class, and risk file and its outcome, as
`Risk low, class test, risk file 3f9c2a7b1e04: passed`, or `findings accepted`
after `--accept`, its target the diff from
the head's merge base with the PR's base. The land gate counts it only from
someone who can push, and a failing one blocks `quest merge --land` as any
failed check does. A token that cannot push sets none, printing `; status
skipped: <why>` after the record's URL.

It then posts the run to Kixel Quest's `POST /reviews` and prints `record
<url>`: the PR, its head, base branch, and merge base, the head's risk tier and
reason, the tier its classifier set, its class, and the classifier model and
session, the run's outcome as the status names it, and each reviewer's round
with its harness, model, effort, seat (`pick`, or `second` for a two-seat rung's
second reviewer), session, round number, score and rationale, and findings,
each with its file, line, severity, and title. Notes are not posted. Beside the
run go the outcomes of the findings an earlier posted round raised that this
one fixed or refuted, each with its reason, named by that round's session and
number and the finding's place in it, and sent to the PR that round was posted
on, even after a replacement PR took the branch. A round whose post failed, or that an older
`quest` recorded in the PR body, was never stored, so the next run sends no
outcome for its findings; the outcomes a failed post carried are kept for
the branch, and its next post sends them, after `--new` too. Kixel Quest counts a run toward merging only when its poster
can push, so a contributor's own runs are recorded but a maintainer's review
decides, and `quest status` reads the review from there; the PR body is left
as written. With no such PR, or a remote off GitHub and Kixel Quest, it posts
nothing and prints `record skipped: <why>`. A post Kixel Quest refuses, or a
status GitHub refuses, fails the command after the round's report, with exit
status 1, a status printing `; status refused: <why>`. It exits 0 once the
round finishes, whatever it found, 2 for invalid arguments or a checkout that
cannot be reviewed, 3 when no eligible reviewer could run, each not installed,
logged out, its login rejected, at its usage limit, or unable to run on this host, and 1 for other
failures. The only eligible reviewer's usage limit prints one line,
`error: <harness> hit its usage limit; resets <time>`, where `<time>` is the
reset as an ISO 8601 UTC timestamp, or `unknown` when the CLI named none; with
several, it prints `error: no eligible <size> <tier> reviewer could run: <model>
<effort> (<error>), ...`.
Through a gateway that pools accounts, such as CLIProxyAPI, the limit is the
pool's: Claude Code shows its "All credentials for model ... are cooling down",
and Codex, sent to `OPENAI_BASE_URL`, gives up on the gateway's 429 after its
own retries, which also counts as the limit there.
`/quest-review` runs the rounds and marks the PR ready.

### Risk tiers

Each head also gets a risk tier, `low`, `medium`, or `high`: its blast radius,
who is hurt if the change is wrong and whether anything catches it first, set
from the change and never from who wrote it. Reviewers never judge it. The tier scales the PR's review and approval, never its CI: every
tier runs the checks its diff reaches, and the next commit's CI or the nightly
run catches what those miss.

| Tier | Local review | Lands on |
|---|---|---|
| Low | Rung `0`–`4` (`XS`–`M`: Sol; `L`–`XL`: Sol + Opus) | Its own, once its local review passes and it is in a built-in class or one in `RISK.md`'s `## Automatic` list; else the maintainer's pick |
| Medium | Rung `1`–`5` (`XS`–`S`: Sol; `M`–`XL`: Sol + Opus) | The maintainer's pick |
| High | Rung `2`–`6` (`XS`: Sol; `S`–`XL`: Sol + Opus) | The maintainer's pick, with the full brief |

`/quest-run` carries the picks.

A change is `high`, with no model, when a changed path on either side of a
rename matches a pattern held high: `RISK.md` itself, `.github/workflows/` and
`.github/actions/`, which run on a PR's branch with the repository's secrets,
and each pattern in the `## High` list of the base's `RISK.md`, at the
repository's root:

````markdown
# Risk

Customers run the relay and the player; the CLI is for contributors.

## Automatic

- `docs` (`docs/**`) - only documentation no other repository reads
- `test` - only tests and their fixtures change

## High

- `src/billing/` - charges customers, and refunds are manual
- `**/*.proto` - peers on older releases read the wire format
````

Each item is a backticked path from the root, where `*` and `?` stay within one
segment, a whole `**` segment spans any number, and a matched directory covers
everything under it, then ` - ` and why changing it is high. The rest of the
file is prose for the classifier, such as what is customer-facing, except
`## Automatic`, whose items are each a backticked class name of lowercase
words joined by hyphens, such as a commit type so a PR title's type reads
beside the class it claims; optionally a scope, backticked patterns joined by
`, ` in parentheses, where every changed path must match one of them whole,
so a scope covers everything under a directory only through a pattern ending
in `/` or `/**`; ` - `; and the rule over the diff a change meets to fall in
it. Each section appears at most once. `quest review` reads the file
from the base's tip, so a change cannot lower its own tier, and fails on one
it cannot read, which the repository's own `quest check`
reports first.

A change that adds or changes a line under `quest/`, a new quest or a move
included, is at least `medium` in every repository, whatever its `RISK.md` says:
agents start a quest's work with no person reading it first, so a plan that
lands unreviewed cascades into everything built from it. The classifier is
told which plans it adds and may answer only `medium` or `high`, and is
offered no class. A change that only removes plan text, such as finishing a
quest or dropping a link, keeps the tier the rest of the diff earns.

Every repository also offers the built-in class `quest` (`quest/**`), for a
change that only removes or cuts plans; a class the base's `RISK.md` lists by
the same name replaces it, scope and rule. `RISK.md` is optional: a base with
none classifies a change as an empty one would, by the always-high paths, the
built-in classes, and the classifier's own scale.

Otherwise a classifier reads the diff and the base's `RISK.md`, if any, in one read-only
turn and replies with a tier, one sentence on why, and the `## Automatic`
class every changed file falls in, or none. It is offered only the classes
whose scope holds every changed path, either side of a rename, checked
before it runs so it judges just the rule and cannot widen a scope; a change
that touches no path falls in none. The scope is checked when the head is
classified, so once the base's `RISK.md` changes, the land gate counts no
review of a high head until a review classifies the head again. It runs as Claude Code
`claude-haiku-5-5` at low effort, then Codex `gpt-6.2-sol` at low when Claude Code is
missing, logged out, has its login rejected, or hits its usage limit. When none can
run, the review fails on the limit that resets first if every one whose CLI is
installed hit its own, and otherwise as a usage error naming why each failed. Its diff ignores the head's
`.gitattributes` and treats every file as text, so a head cannot hide hunks by
marking them binary. A diff past 200,000 characters, or one holding a NUL byte or bytes that are not
UTF-8, gives it only the stat and a file of the whole diff in a scratch directory, which Claude Code is
let read and which is removed once it answers. The tier is kept with the reviewers'
sessions, so a later round on the same head, base `RISK.md`, and built-in
defaults reuses it, and `--new` classifies again. The post names the
classifier model and session, or none when the always-high paths set the
tier; the status names the base's `RISK.md` the tier was set against by its
blob's first 12 characters, or `none`, which a status without it names too.

Every tier runs a local review. On rungs `0`–`2` (`XS low/medium/high`,
`S low/medium`, and `M low`), one reviewer runs, falling from Sol to Opus when Sol
cannot run. On rungs `3`–`6` (`S high`, `M medium`, `L low` and up),
the head gets a second reviewer: its rung's entry from the other
vendor, so Sol and Opus both review it. It is marked `second`, in a session
of its own that reviews every head on a two-seat rung and settles its
findings after even if a later head drops to a one-seat rung. `--model` and
`--effort` change only the pick, so a two-seat rung's second
reviewer still runs; the one reviewer `--harness` names runs alone. When the
other vendor's model is avoided on a two-seat rung, as by `--exclude-model`,
the run fails as a usage error (pass `--harness` to run one reviewer alone);
when either seat cannot run on a two-seat rung, it fails as an outage.

`--override <tier> --reason <text>` records the maintainer's tier for the
branch in place of the reviewed one, posted as the run's tier and reason beside
the classifier's own tier. It holds across heads until
the reviewed tier grows riskier than the one overridden, other than to the
override's own tier, which agrees with it, and `quest usage`
counts overrides as a reading of the tier's accuracy.

`--accept <reason>` records the maintainer's acceptance of the findings the
head's last rounds left open, as when they side with the author against a
reviewer that keeps a finding, or at a `next decide`. It
runs no reviewer and no classifier: it repeats each reviewer's last round of
the same head, base, and merge base, sets the `quest review` status to
`failure`, described `findings accepted`, posts the rounds again as
accepted, each open finding deferred for the maintainer's reason on the PR it
posts to and on a since-replaced PR its round was posted on, and only once the
post is stored sets the status to `success`. It is a usage error when no round
classified and reviewed that diff, when a two-seat rung lacks its second
reviewer's round, or when no finding is open, and it takes no option that
would run or reset a round. Its status goes first, so a token that cannot
push records nothing, printing `next stop` and exiting 1.

## Audit cost and accuracy

`quest usage` reports `origin`'s PRs updated since `--since` (a local
`YYYY-MM-DD`, by default 7 days ago) and the agent sessions this host, and
each host `--ssh` names, ran since then: which harness, model, and effort
worked on each PR, in which role, at what token cost, and how the work went.
This report is of a PR merged before Sol 6.2, so it names the models that ran.

```console
$ quest usage --pr 569
kixel-ai/quest, PRs updated and sessions active since 2026-11-06; costs (~$) estimate API list prices

#569 S medium merged: quest: finish model routing (quest/m0/model-routing/README)
  risk: medium, It changes which model reviews each PR size.
  implementer: Claude Code, claude-opus-5-5, unknown effort
  review: Codex, gpt-6.1-sol, medium effort; round 1, score 10/10; rounds 1, findings 0: fixed 0, refuted 0, open 0
  online review: review (OpenAI), not at the final head; 0 findings: 0 accepted, 0 declined, 0 unclassified, 0 unanswered
  land fixes: codex, gpt-6.1-sol, medium effort
  sessions:
     implementing  local  claude  claude-opus-5-5   low     in 50, cache 36.2k written 1.1M read, out 6.1k, ~$0.63
     reviewing     local  codex   gpt-6.1-sol       medium  in 14.7k, cache 0 written 39.8k read, out 421, ~$0.04
     classifying   local  claude  claude-haiku-5-5  low     in 9.2k, cache 0 written 0 read, out 38, ~$0.00
  waits: gate-run 4m, pull 12m
  time: writing 9m (41%), understanding 6m (27%), testing 4m (18%), reporting 3m (14%), idle 2m
  went wrong (implementing): the first test run failed on a stale build and was rerun after rebuilding
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
unattributed. A session on no such branch, such as a sub-agent in a detached
checkout, belongs to its parent's PRs unless its own repository is known to be
another, and a coordinator whose sub-agents worked on several PRs belongs to all
of them, its cost counting equally toward each, so a PR's sessions add up to its
whole cost. Each session gets the record
[`quest records sender`](#session-records) would send, and its role comes from
it, so a review's sub-agents count as reviewing. Each PR shows its `## Models` size, its risk tier and
whether a reviewer raised it, and its implementers, and as `unread:` each Implementer line it cannot read; each reviewer the
`quest review` record names, with its latest round and score and its tally of
findings across every round, marked `shadow` or `second` for those seats, where a merged PR whose last round left only low
findings open counts them settled, as `/quest-review` once had those fixed or
refuted before merge without another round; the land fixer's fixes; the later merged PRs
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
by size and implementer, which sums the tallies but the shadow's, and their
first rounds over the PRs whose every such tally records one, so it counts
every finding the routed reviewers caught before merge, while the shadow's
findings measure an effort step rather than the writer. Since a branch's tallies span every PR from it, only the
PR whose record holds its latest tally, by the most rounds and then the newest,
counts them, and a record written before tallies
counts as unreviewed. An `Implementer:` line's own size, as
`(iterate, XS)`, counts over the PR's, and a line naming an advisor, as
`(advisor claude-opus-5-5)`, is its own implementer. The writer A/B reports by size, cohort, and arm,
with the same outcomes and every session's spend, its advisor's included, counting a sized PR only when
each of its `Implementer:` lines names the same arm, cohort, harness, model,
effort (`unknown` matching any), and advisor; lines that name no cohort, written before cohorts, report under `-`. Each implementer also carries its
writing sessions' cost on the merged PRs they were found on, so cost per merged
PR divides by those PRs, not the ones no host reported: a PR's spend on a
model goes to its line of that model or the line it advises, whose tokens
token-max reports under the advisor's own model, of the same effort where both name one,
and spend on a model no line names, such as a sub-agent on a smaller model,
to the line that took the most. Spend that fits several lines goes to the
first line when an implementing session spent it and to the later ones when an
iterating one did. Local reviewers roll up the same way, by the
PR's size and each reviewer's harness, model, effort, and shadow mark: PRs
reviewed, tallies, first rounds, and reviewing cost per PR, where a session
the record names, or its sub-agent, goes to that reviewer. Spend still left
fitting several, such as a routed and a shadow reviewer at one effort whose
sessions no record names, is split evenly among them and reported as `split`.
Each risk tier's PRs, how many merged,
how many a reviewer raised, how many the maintainer overrode, how many a later
PR's `## Caused by` names, and how long they waited on a person show whether
the tiers predict what breaks and what each costs. Each `## Automatic` class
the classifiers named gets the same numbers, and how many of its PRs were low,
to argue for or against merging the class without a pick. A local reviewer
row marked `second` shows what the high tier's second review catches. Each breakage a merged PR in the
window names under `## Caused by` follows on its own line, by culprit, even one
older than the window, which is read from GitHub: the culprit's tier, size,
writers, and local reviewers, who found it and the incident it closes when
the bullet ends with
`(found by check|reviewer|queue|canary|person|customer; incident <id>)` as the
rules ask, either part alone allowed, and how long after the culprit merged the fix opened. Over the merged
PRs come each online
reviewer's coverage, final heads reviewed, findings per PR reviewed, and
answers. A hand-back counts only while its draft is open, so a merged PR
never shows one.
Sessions on no PR here, from any
repository or agent token-max reads, total on an `Unattributed` line. `--pr` and
`--quest` narrow the report to one PR or one quest's branch, and `--json`
prints it as one object. Without `token-max` on `PATH`, it says how to install
it and reports the PRs' records alone. Each PR's `waits:` line sums its
sessions' waits by kind, a shared session's in its share, and its `time:` line
their [time splits](#time-splits) the same way, with each note on what went
wrong; a `Time by role` rollup sums each role's splits, how much of the time a
checker labeled again it labeled differently, and what labeling took.

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
latest upload, since one sender sends a session's uploads in order. The type is
`SessionRecord`, exported from `quest/core` with `parseRecord` and
`parseUpload`, which refuse a malformed record whole:

```json
{"harness":"claude","session":"7ef44bda-fb9b-436f-9ed8-9013d0f38d46","parent":null,"repository":"acme/app","branch":"quest/m0/login","quest":"quest/m0/login.md","pulls":[42],"role":"implementing","models":[{"model":"claude-opus-5-5","effort":"high","input":230,"cacheWrite":211500,"cacheRead":15800000,"output":88800,"cost":6.64,"complete":true}],"cost":6.64,"complete":true,"start":"2026-11-14T00:06:12.270Z","end":"2026-11-14T00:31:40.120Z","waits":[{"kind":"gate-queue","start":"2026-11-14T00:22:07.386Z","end":"2026-11-14T00:22:07.402Z","until":null},{"kind":"gate-run","start":"2026-11-14T00:22:07.402Z","end":"2026-11-14T00:24:51.020Z","until":null}],"gated":[{"command":"just test","start":"2026-11-14T00:22:07.386Z","admitted":"2026-11-14T00:22:07.402Z","end":"2026-11-14T00:24:51.020Z","cpu":1214300}],"shell":[{"calls":[{"command":"git status","start":"2026-11-14T00:21:58.004Z","end":"2026-11-14T00:21:58.051Z"}],"cpu":30,"shared":false}],"split":null}
```

- `pulls` are the PRs it worked on, attributed as `quest usage` attributes
  them; a session with none yet, such as planning before its PR opens, keeps
  its `branch`, and the next record names the PR. The sender remembers a sent
  session while its latest branch, or a sub-agent's, heads no PR, and resends
  it, with its sub-agents, once one opens: with the next session it sends from
  that repository, since only then does it read the repository's PRs. It
  forgets the session once the harness prunes its transcript.
- `role` is classifying when `quest review` ran it as the
  [risk classifier](#risk-tiers) or an earlier PR's `## Review` record names it
  so, reviewing when it ran it as a reviewer, such a record names it so, or
  Codex marks it a review, else the one the first quest skill it ran gives: planning
  (`/quest-plan`, `/quest-recurring`, `/quest-import`,
  `/quest-grill`, `/quest-delete`, `/quest-export`), implementing
  (`/quest-start`), iterating (`/quest-iterate`), reviewing (`/quest-review`),
  merging (`/quest-merge`, `/quest-complete`), or coordinating (`/quest-run`,
  `/quest-spawn`). Without one, a sub-agent takes its parent's role unless that
  is coordinating; a session on its sub-agents' PRs only is coordinating; one
  on a `quest-plan/`, `quest-recurring/`, or `quest-import/`
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
- `gated` lists each outermost `quest gate` run: its `command`, when it
  asked to start, when it was `admitted` (null when it ended queued), when it
  ended, and the CPU milliseconds its command used, read from its systemd
  scope once it exits, or null where the gate owns no scope, as on macOS or
  Windows. The gate logs
  each run as one line among the waits, and the record takes its
  `gate-queue` and `gate-run` waits from it. `nix build` counts little here,
  since `nix-daemon` builds outside the scope.
- `shell` lists its shell calls, each with its `command`, in groups: calls that
  overlapped, in parallel or in the background, are one group. A group's
  `cpu` is the milliseconds the session's own cgroup used from its first
  call's start to its last call's end, which counts what ran outside the
  gate, and the harness meanwhile, but no gated command, whose scope is
  elsewhere. Quest's tool hooks sample that counter around each call into
  `$XDG_STATE_HOME/quest/calls`, kept like the waits, and only where the
  cgroup holds the session alone: one tree of processes whose top is the
  harness, the process Claude Code names in `CLAUDE_PID` or one named
  `codex`, as when an app such as T3 Code starts each agent session in a
  systemd scope of its own. A terminal's scope has the terminal's shell on
  top, so its groups, like those on macOS, have a null `cpu`.
  A call Claude Code moved to the background runs until the first turn end
  that no longer lists it; a call that never returned, as one denied, is
  left out. Codex's calls end when the tool returns, so a command it left
  running counts only until then. A group shared by sessions in one cgroup,
  as a sub-agent's with its parent's, is in each of their records, listing
  only that session's calls, with `shared` true. Both lists are null for a
  session on another host; `gated` counts the runs that ended since the
  window's start, and `shell` the groups that started since then. To find
  where a group began, `quest usage` reads the call log from the day before
  the window's, and earlier days while a call it read began on one; only a
  background call handed off and finished within one turn of over a day can
  still split a group at the window's start.
- A `command` keeps only the programs it ran, in order and each once, with
  the subcommand of those that take one, such as `cd; cargo build; tail`:
  never arguments, assignments, redirections, or here-document bodies, since
  a command line can carry a secret and records leave the host. Programs
  such as `git`, `cargo`, `just`, `nix`, and `npm` keep their subcommand
  when it is one of a fixed list of common ones, such as `build`, `check`,
  and `test`; any other's first argument is data and stays. A program counts
  only as a shell builtin or one the host can run, on `PATH` or by its path,
  so a variable, or a word Quest's reading of the script mistook for a
  program, is `?`.
- `split` is where the rest of its time went, as the next section describes;
  null until every step is labeled, and for a session on another host.

The record holds no prompt, reply, or transcript text: skills and questions
are read from the transcript on this host, and only their names and times
leave it. The split's notes are lines a model wrote, told to name no one and
quote no message.

Records go to [Kixel Quest](https://kixel.quest), the same one the
[forge reads](#read-through-kixel-quest) use, at its `/records`, with the token
`quest login` stored for its URL. No repository commits a config file: a record names its repository by `owner/repo`
from its checkout's `origin` (the repository its PRs open on, for a fork), and
the token is sent only to the URL the user's own file pairs it with. The URL is
`https://kixel.quest`, or HTTPS (HTTP to `localhost`) `QUEST_KIXEL_URL` for
another Kixel Quest, such as one running locally, as the stop hook's environment names it.
A host not signed in to it sends nothing, and the hook says once, as a system message, to run `quest login`.
The hook queues each record with that URL, and the sender sends it there with that URL's token whatever
its own environment names, so one queue can serve several Kixel Quests; it drops a record only when the
host signed out of that Kixel Quest or it refused the token.

No hook runs in a reviewer, so `quest review` queues each Claude Code and Codex session it starts or resumes
the same way, its classifier's and each reviewer's, once the round's record names them, so reviewer spend reaches Kixel Quest
beside the writer's. A round that reuses its sessions runs no turn and queues nothing; one that resumes a
session queues it again, and its record replaces the earlier copy. A failure to queue is said on stderr and never fails the round.
Each carries the PR the round recorded on, the branch it reviewed, and its role, classifier or reviewer, which the
sender takes over what it infers, so a session from the runner's review checkout or a detached one is sent on that PR, a
fork's included, as is a sub-agent it starts anywhere in that checkout, and a classifier whose reply was unusable is still
counted as one. A round that recorded on no PR is sent on a PR its branch heads in the checkout's own repository, never
on a stranger fork's of the same name.

Kixel Quest refuses a whole upload naming a repository it does not index or
the sender cannot read, so the sender asks `GET /forge` which repositories it
serves and sends only those. The rest are dropped from this host's queue, so an
unserved repository costs no GitHub requests, and the next stop says so once.

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
instant, reads the PRs updated since then, or since its last upload for that
repository read them, if earlier, so a fix merged after its
sessions were sent still goes with the next one, labels each session's new
steps for its [time split](#time-splits), and posts
`{"records": [...], "breakages": [...]}`, the breakages being those the merged
PRs among them name under `## Caused by`, as `quest usage` reports them, with
`Authorization: Bearer <token>`, one upload per repository, each
queued session with its sub-agents, which stop without the hook naming them.
Each upload is checked with `parseUpload` before it is posted. A 2xx drops the
sessions from the queue, unless the hook queued one again meanwhile. A 401 or
403 drops them and sends Kixel Quest nothing more until `quest login` signs in
again; a token a new sign-in replaced during the pass keeps them queued.
Any other failure keeps them queued, and the next stop says so once. A failing
repository backs off, waiting a minute and doubling up to six
hours, and sits out the passes meanwhile, so it never widens the others'
window. token-max missing is retried each pass.

A deploy or alert reports what it found with `quest records incident`, which
posts one breakage at once to Kixel Quest and fails loud on any
answer but a 2xx, since nothing retries it:

```console
$ quest records incident https://alerts.example/1 --found canary
reported https://alerts.example/1 open, its culprit unknown
$ quest records incident https://alerts.example/1 --found canary --pr 42
reported https://alerts.example/1 against #42
```

The ID is the reporter's, and a report with the same ID replaces the last. An
incident stays open, and the store counts open ones apart, until it is
reported again with `--pr`, or a merged fix names it on its culprit's
`## Caused by` line, as `(incident https://alerts.example/1)`: the sender then
sends the fix's breakage under the incident's ID, so it replaces the open one
as one record holding the culprit, the fix, and the incident. Where several
fixes name one incident, the one updated last wins. One fix closes several incidents of a
culprit with a line for each. `--found` is one of `check`, `reviewer`, `queue`,
`canary`, `person`, or `customer`, and `--at` sets when it was found, as
an ISO 8601 date and time with a `Z` or offset, by default now. Reverts and red default-branch runs are not reported here: the
store reads them from GitHub itself.

### Time splits

Before the sender builds a record, a cheap model, Claude Haiku at low effort,
else Codex's `gpt-6.2-sol` at low, labels each step of the session's
transcript it has not labeled yet: each tool call or message, with its time
and a trimmed result, sorted into a fixed list of categories: `understanding`,
`researching`, `writing`, `testing`, `environment`, `git`, `forge`,
`reviewing`, `rework`, `coordinating`, `operating`, `reporting`, `circles`
(going in circles), `waiting`, and `other`. `idle`, the time between turns, is
measured, never judged. Each stretch of the transcript goes to the step it
ends at, less the part a timed wait covers, so the categories and the timed
waits sum to the transcript's span and the categories' tokens to its tokens,
whatever the model judges. Each part also gets one line on what went wrong,
if anything did, cut to 300 characters. A reply that is not labels covering
every step of its part passes the part to the next model. About one part in
ten is labeled again by a stronger model, Claude Sonnet at medium else
`gpt-6.2-sol` at medium, and the split reports the time the two labeled
differently, so the classifier has a known error; a check no model could give
leaves its part unchecked. The split's `usage` is what labeling took, by model,
unusable replies included.

The labels are kept under `$XDG_STATE_HOME/quest/records/splits`, so each stop
labels only the new steps, and `quest usage` reads them without asking a model.
The transcript text reaches only the labeling model, never the store. Labeling
never holds a record back: a session no model could label, such as with every
model logged out, is sent without its split, the next stop says why, and the
session's next stop labels the steps still unlabeled.

### Typed messages

`quest messages` prints the messages a person typed to agents on this host
since `--since` (a local `YYYY-MM-DD`, by default 7 days ago), oldest first,
for a periodic audit of what agents keep getting wrong. It reads every
repository's sessions and prints only the entries of the checkout it runs in;
`--all` prints every repository's. Outside a checkout whose origin is on GitHub
or Kixel Quest it exits 2 and asks for `--all`. It notes on stderr how many
other repositories it dropped entries of, and how many of those are directories
no origin names, since they may hold this repository's sessions:

```console
$ quest messages --since 2026-11-10
2026-11-10T17:39:10.552Z claude kixel-ai/quest 5f0c2a7e-9d3b-4c1a-8e6f-2b7d4a9c1e03
  quest-run
```

Each message shows its time, harness, repository (the checkout's `origin` on
GitHub as `owner/name`, or on Kixel Quest as `<host>/owner/name`, compared
without case, else its
directory; a removed worktree under a checkout's `.worktrees/` or
`.claude/worktrees/` takes that checkout's, one T3 Code removed takes its
project's; a Codex session takes the origin Codex recorded unless that is
the directory's configured origin or the URL git fetches it from, after
`insteadOf` rewrites, and any other keeps its directory), and session, then its text. It also prints each
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
other Codex sessions count the content Codex marks as the user's (before 0.162,
which marks none, the parts but its environment, shell commands, and AGENTS.md instructions),
outside headless (`codex exec`) and sub-agent sessions. A log or record in a
shape it does not know, in any repository, fails the command rather than being
skipped. Output goes to
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
starts or resumes a sub-agent of its own. The host has room while its memory
would admit a gated command at once, as `quest gate` counts it, with one more
command's budget taken for every agent admitted in the last 5 minutes: an agent
adds no gated work until its first build, and three quarters of those that build
at all reach it by then. An agent `start` or `resume` runs stops counting when it
exits. On Linux, where the gate runs commands in the user's `background.slice`, that
slice counts too, as it does for the gate, so a slice at its cap holds agents back however much memory the host has
free. CPU load and commands queued for the gate do not hold agents back: an
agent mostly waits on its model, and its builds wait in the gate. On macOS,
where the gate reads no memory, and on Windows, where memory alone does not
bound agents, the host has room instead while `quest gate`
would admit a command at once, counting every command queued for it and each
agent admitted in the last 5 minutes as one recent admission; as in the gate, a
host loaded only by work no gate holds still starts one agent at a time.

Admission only delays the next agent: none already running is paused or
stopped, and `quest agent stop` does not see a launch still waiting, which ends
when its command is cancelled.

Options go before the worktree, and the prompt or message follows it, so text
starting with `-` is never read as an option. The agent runs in the worktree
with the user's environment minus the coordinating session's harness variables
and credentials (keeping `CLAUDE_CONFIG_DIR` and `CODEX_HOME`), secret-manager
tokens, and any `quest gate` admission or priority, so it uses the CLI's stored
login rather than the session's. `--permission-mode` is Claude Code's
permission mode, or Codex's sandbox mode; the agent cannot prompt.
`--advisor <model>` turns on Claude Code's advisor tool with that model and
sets `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1`, without which Claude
Code drops the tool silently on an account its rollout has not reached; Codex
refuses it. Each
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
hosts, and fails a run whose scope its user manager has not started within 60
seconds. It handles signals as the gate does on such a host: SIGINT, SIGTERM, or
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
| `quest-plan` | Ask the questions that turn an idea into scoped quests, including recurring ones whose finishing PR creates the next run. |
| `quest-import` | Bring open GitHub issues into the planning conversation. |
| `quest-start` | Claim a ready quest, complete it, and open a PR. |
| `quest-iterate` | Iterate on an open PR to settle its open decisions, fix CI and review findings, and push. |
| `quest-review` | Review a PR's branch locally with a model no weaker than its latest writer, then mark it ready for review. |
| `quest-merge` | Queue a PR to land, running `quest-iterate` first when it needs work. |
| `quest-run` | Orchestrate a project from one session: start ready quests, take PRs to merge, and settle what quests and drafts wait on you, in a loop until only your decisions remain, then plan the follow-ups no quest owns yet. Pass a filter such as `prs` to start no quests. |
| `quest-afk` | Keep a session such as `quest-run` going while you are away: it acts on its recommendations, defers merges, and walks you through the rest when you return. `afk merge` also merges low-risk PRs it recommends, implements the follow-ups it recommends doing now in the PRs that add them, and once idle merges a medium-risk PR that unblocks a quest it would start; and `afk soon` asks pending questions in one batch before you leave. |

Use `/quest-plan` in Claude Code or `$quest-plan` in Codex. Skills coordinate
within your agent session. A started quest stops at a pull request; merging is
a separate invocation, so you review every change.

To use Quest in your own repository, paste this into your agent:

```text
Follow https://github.com/kixel-ai/quest/blob/main/SETUP.md to set up Quest here.
```

The [getting started guide](docs/getting-started.md) covers what happens next.

`quest context` prints the rules agents follow in every task, `quest context <pack...>`
prints on-demand topic packs (`pr`, `review`, `rust`, `ts`, `uniffi`; `--list` lists them), and `quest guide`
prints the quest format and workflow agents read before working on a quest outside a skill;
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
hook on shell commands, file edits, and question dialogs denies, with the rule
as the reason:

- an edit, commit message, or new GitHub post that adds an em dash outside a
  `>` quote line;
- a `git push` whose refspecs lack a `:`;
- a force-push, `git rebase`, or `git pull --rebase`, unless the command
  starts with `QUEST_USER_ASKED=1` because the user asked for it;
- a new GitHub post (`gh pr create`, `comment`, or `review`, `gh issue create`
  or `comment`, or `gh api` with a `body` field) without a `(Written by ...)`
  line;
- a scratch file written under `/tmp`, outside the checkout, by a redirection,
  `tee`, `mkdir`, `mktemp`, `git clone` or `worktree add`, or a file edit;
- killing processes by name with `pkill` or `killall`, which can hit sibling agents;
- loading the CPU with `stress`, `stress-ng`, or `yes` writing to `/dev/null`,
  which starves sibling agents;
- `cargo test` or `mbx test`, other than `--doc` or `--no-run`, in a Cargo
  workspace whose `.config/nextest.toml` kills hung tests with
  `terminate-after`, since plain `cargo test` skips it, unless the command
  starts with `QUEST_USER_ASKED=1` because the user asked for it;
- in a checkout whose origin is on [Kixel Quest](#work-on-a-repository-kixel-quest-hosts),
  a `gh pr` or `gh api` call aimed at that repository, which `gh` cannot reach:
  one naming no repository, through `--repo`, `GH_REPO`, a PR URL, or an
  endpoint's `repos/<owner>/<repo>`, or naming that one by its owner and name
  or on Kixel Quest; a URL or host elsewhere, such as github.com, names
  another repository. The reason names the `quest` command to run, such as
  `quest pr view`;
- a question dialog, Claude Code's `AskUserQuestion` or Codex's
  `request_user_input`, with a question of two or more options none of which
  ends with `(Recommended)`.

For Claude Code, `Stop` and `SubagentStop` hooks refuse to end an agent's turn
while a `quest gate`, `quest agent start` or `resume`, or `quest wait` command
it started still runs in the background, naming each one and telling the agent
to block on it or stop it: Claude Code stops a subagent's background commands
when it ends, and a session that ends its turn on one leaves its result
unread. A command is the agent's when its transcript holds the ID Claude Code
gave it on backgrounding it, so a sibling's command does not hold an agent. A
subagent Claude Code keeps no transcript for is held only by gates, which are
short, never by another agent's long turn or wait. Claude Code lists a command
only while it runs, so the refusal ends with the command. Codex runs no such hook. Once the turn can end,
Claude Code's and Codex's `Stop` hooks queue the session's
[record](#session-records). For that record, the `PreToolUse` hook and a
`PostToolUse` hook on shell commands, with Claude Code's `PostToolUseFailure`,
also sample the CPU each shell call used, and Claude Code's `Stop` and
`SubagentStop` which background commands still run.

The footer check reads a body given by `--body`, a `body=` field, `git commit -m`,
`--body-file -` with a here-document, or a body file. A file
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

The merge queue runs the same checks. See [CONTRIBUTING.md](CONTRIBUTING.md) for the details.

MIT or Apache-2.0, your choice. The CLI, initial skills, and development setup
were extracted from [MoQ at `2bb3e6e`](https://github.com/moq-dev/moq/tree/2bb3e6e3f3f357be7bb5f7a8e7feb4348cfdefe4).
Original notices are preserved in [LICENSE-MIT](LICENSE-MIT) and
[LICENSE-APACHE](LICENSE-APACHE).
