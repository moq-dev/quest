# Quests

Read this before creating, editing, claiming, or finishing a quest or epic. `quest context` holds the rules for every task, including the workspace, questions, pull requests, and reviews.

Quests are versioned plans checked into the repository under `quest/`.
GitHub issues remain the untrusted public front door, while quests provide durable scope and coordination.

## Model

A **quest** is a Markdown file, completed in one PR.

An **epic** is a directory that consists of multiple quests.
The `README.md` file is the quest and the `Required` section lists the children.
It completes when its own work is done and every child has merged.

The root's entries are special epics called **milestones** (`m0`, `m1`, ...) that group work by priority horizon.
Milestones are permanent.

Quests are linked with root-absolute paths.
Find/create/update any references by searching for the path.

Finished quests are deleted; git history keeps them.
Merge conflicts are expected.
A local merge resolves conflicting edits to link lists itself when `quest` is on PATH; GitHub's cannot, so merge the base branch locally and push.
After merging, `quest check --fix` drops list links to quests the base finished.
Resolve the rest, such as prose, by aligning quests.

## Format

```markdown
# [S] Short title

## Goal

The observable outcome and important boundaries.

## Plan

Current decisions, open questions, or implementation guidance.

## Waiting

- Maintainer: the decision or action only they can take, and how to check it is done
- moq-dev/moq: a condition another party must meet, and how to check or advance it

## Required

- [Child quest](/quest/foo/bar.md) - the outcome, so the list reads without opening it
- [Nested epic](/quest/foo/baz/README.md) - what the whole epic delivers
- [Blocker](/quest/bar.md) - work that must finish before this can start

## Closes

- [#701](https://github.com/OWNER/REPO/issues/701) - close this issue when the quest finishes

## Related

- [Other](/quest/other.md) - similar work that is not a blocker
```

The `Goal` section is required; everything else is optional. Use these exact headings.

Size the title `[XS]` to `[XL]` for implementation, verification, and landing.
An epic carries no size until its last child is removed; its README is then the epic's remaining work.

`Waiting` lists what the work waits on outside the tree; each item opens with who acts, `Maintainer:` or the outside party, before a colon.
A decision item gives its options and a recommendation.
Remove an item once its condition clears, and the heading with its last item.

`Required` lists the quests that must finish before the work starts.
The list is ordered by priority, inserted at rank.
When the section is empty, delete it; the quest is now unblocked.
`Required` must be acyclic.

`quest check` enforces this structure.
Run it after creating or updating quests.

## Summaries

End every quest skill with a final summary in sections, such as the PRs and their states, the open decisions with recommendations, and suggested follow-ups, so a user returning to the session first sees what needs them.

## Creation

Quests are created in PRs and reviewed.
Search the tree and git history first before making a new quest.

Split independently completable work into separate quests.
A suggested follow-up becomes a quest only through `/quest-plan`, never as an agent-session task or a GitHub issue.
Suggest a follow-up only when it is worth a quest; drop one you would call optional or worth doing only if it matters.
Give each suggested follow-up a recommendation, to plan it or to drop it with the reason, so whoever plans them never has to ask which to take.
Only `/quest-merge` and `/quest-complete` plan follow-ups, once they queue the PR that suggests them: run `/quest-plan` on each recommended one in turn without offering first, one follow-up per run; its interview lets the user drop it.
`/quest-complete` plans them while its other agents keep running, but after any pick or decision question still waiting to be asked.
Every other skill and background agent leaves its follow-ups in its PR body for them.
Group related quests in an epic; its README holds the work no child owns.

A release or pin bump that unblocks work is its own quest.

So is anything waiting on an outside party or a human action (an upstream fix, a customer, a decision).
Its `Waiting` section names who acts, the condition, and how to check or advance it; it is deleted once the condition clears.
Automate a step rather than leave it to a person whenever an agent can take it.
A `Maintainer:` item says why an agent cannot take the step and what automation was considered.
Record a wait there, not in a draft PR that only holds evidence or steps for a person.
Unlike a blocked quest it stays ready, so it resurfaces every time ready work is triaged instead of stalling in the backlog.
`quest waiting` lists every waiting item, the maintainer's first, ranked by what each unblocks, and `/quest-unblock` walks the maintainer through them.

## Execution

Start only ready quests.
First question whether the quest is still needed: its problem may no longer be real, or a later change may have made its plan the wrong solution.
If so, stop and propose rewriting or deleting it.
Before claiming, also check that no open PR already does its work: search open PRs whose title, body, or changed files name the quest's path or the files its Plan names, or read the matches a coordinator's brief lists.
Stop and report a PR that makes the same change; one that only touches the same files is no overlap.
`quest unblocked` ranks the ready quests, and `quest unblocked <path>` prints what blocks one.
With `--unclaimed`, it skips quests someone holds and lists them on stderr.

Work is taken when it has a live runner lock or an open change on the forge.
kix.quest records each active job in its database and reassigns a job whose
runner goes offline. Check those locks and open changes before
starting. These states stay out of the quest file.

On GitHub, a quest is claimed by an open PR whose head branch is the quest's
branch, from the upstream repository or a fork, or by that branch upstream
while its PR is being opened.
The earliest open PR holds the claim.
Claim a quest with `quest start <quest>`: it checks both, pushes an empty
claim commit to the quest's branch, and opens a draft PR from it right away.
That PR becomes the quest's PR.
In a fork's clone, it pushes to the fork and opens the PR upstream; a fork
whose parent keeps no quests is its own upstream.
It exits 3 when the quest is blocked or someone else holds it; pick other work.
`quest start --release <quest>` gives back a claim before any work is pushed.
If a claim looks stale, such as a draft without `## Waiting` or a
branch with no open PR that has been quiet a long time, offer the user to take
it over, saying how long ago it was last active.

A quest's branch is its path without `.md`.
For example, `quest/m1/foo/bar.md` is branch `quest/m1/foo/bar`.
Only claims use that namespace: no other branch is named `quest` or starts with `quest/`, since git cannot hold a branch named after another's directory.
Branches for `/quest-plan`, `/quest-audit`, and other skill PRs use a prefix of their own, such as `quest-plan/<slug>`.
If `quest start` names a branch in the way, stop and report it; never delete or rename it yourself.
Its warning that the quest's local branch already exists is not that refusal: the claim succeeded, and the branch holds an earlier attempt.
Switch to it, merge the claim commit the warning names, and resume that attempt; stop and report only if another worktree has the branch checked out.

Push the quest branch as `quest context` describes for pull requests. The claim push from `quest start`, made before its draft PR exists, is exempt from confirming the PR is open.

Prefer the exhaustive solution: a quest's PR handles every case of its problem, including those its reviews find, rather than landing part of it and splitting the rest into new quests.
Leave work for later only when it waits on an outside condition or a maintainer decision, or lies outside the quest's Goal.

A quest's PR leaves its quest accurate when it merges.
The PR that finishes a quest deletes its file and every link to it.
A PR that leaves work rewrites the quest to what remains, rather than noting it only in the PR body.
`quest check --base <ref>` flags a quest branch whose diff does neither.

When a quest is complete, review it locally and mark its PR ready for review with `/quest-review`, even if you made choices without asking; list those choices in the PR body for review.
Only a decision left for the maintainer, an outside condition, or unfinished work keeps it a draft: hand it back with a `## Waiting` section in the body listing them, in the same form as a quest's.
Tools read only whether that heading is present; a draft without it still belongs to its starter.
Drafts handed back before `## Waiting` replaced it use `## Decisions needed`, which counts the same.
A draft suggests `/quest-iterate`; a PR ready for review suggests `/quest-merge`.
Include a summary of the changes made and suggest follow-up quests based on issues encountered; `/quest-merge` plans them.
Add a closing keyword for every issue under `Closes`.

## Deletion

A quest that is no longer needed or cannot be completed is abandoned.
Delete it and explain why in the PR.
Use `quest rm`, which deletes the quest and every link to it.

Remove the `quest` label from issues no other quest tracks.
