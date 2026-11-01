# Quests

Read this before starting any work: [Workspace](#workspace) applies to every task, and the rest whenever work mentions a quest or epic.

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
Resolve the rest, such as prose, by aligning quests.

## Format

```markdown
# [S] Short title

## Goal

The observable outcome and important boundaries.

## Plan

Current decisions, open questions, or implementation guidance.

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

`Required` lists the quests that must finish before the work starts.
The list is ordered by priority, inserted at rank.
When the section is empty, delete it; the quest is now unblocked.
`Required` must be acyclic.

`quest check` enforces this structure.
Run it after creating or updating quests.

## Questions

Make every reference you show the user clickable: link issues, PRs, and commits by full URL, as in `[owner/repo#123](https://github.com/owner/repo/pull/123)`, never a bare `#123`.
Sub-agents report those URLs so the parent can link them.

Block on user decisions.
Explain the quest or PR, the decision, and your recommendation, then ask synchronously with a blocking interactive question tool when available and allowed in the current mode.
Do not use asynchronous question tools.

If no blocking tool is available, or it returns without an answer, put the question and numbered choices in your final reply and end the turn.
Resume when the user answers; do not bury the question in a progress update or replace the wait with sleeps or timed polls.
Silence, elapsed time, and a preselected recommendation are not answers or approval.
Do not advance the interview or act on an unanswered choice.
Already authorized background work may continue while the foreground waits.

A sub-agent's brief carries the quest or PR, the user's picks, and the scope; it leaves repository rules to that repository's own instructions instead of restating them.
A background agent reports any decision needing user input, with context and a recommendation, to the foreground agent instead of prompting the user itself.
Honor explicit instructions to proceed unattended within their scope; do not ask a question and then silently choose its answer.
When recorded decisions conflict, such as a newer PR comment or quest Plan against an older brief, follow the newest and note the change in the PR body; ask only when it is unclear which is newer.
A decision about an open PR never authorizes closing it. Confirm a close as its own question, and comment on the PR before or with it.

End every quest skill with a final summary in sections, such as the PRs and their states, the open decisions with recommendations, and suggested follow-ups, so a user returning to the session first sees what needs them.

## Creation

Quests are created in PRs and reviewed.
Search the tree and git history first before making a new quest.

Split independently completable work into separate quests.
A suggested follow-up becomes a quest only through `/quest-plan`, never as an agent-session task or a GitHub issue.
Plan recommended follow-ups without offering first: run `/quest-plan` on each one in turn, one follow-up per run; its interview lets the user drop it.
A background agent that cannot prompt reports them, and its caller plans them the same way.
Group related quests in an epic; its README holds the work no child owns.

A release or pin bump that unblocks work is its own quest.

So is anything waiting on an outside party or a human action (an upstream fix, a customer, a decision).
Its Goal names the condition and how to check or advance it; it is deleted once the condition clears.
Unlike a blocked quest it stays ready, so it resurfaces every time ready work is triaged instead of stalling in the backlog.

## Execution

Start only ready quests.
First question whether the quest is still needed: its problem may no longer be real, or a later change may have made its plan the wrong solution.
If so, stop and propose rewriting or deleting it.
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
If a claim looks stale, such as a draft without `## Decisions needed` or a
branch with no open PR that has been quiet a long time, offer the user to take
it over, saying how long ago it was last active.

A quest's branch is its path without `.md`.
For example, `quest/m1/foo/bar.md` is branch `quest/m1/foo/bar`.
Only claims use that namespace: no other branch is named `quest` or starts with `quest/`, since git cannot hold a branch named after another's directory.
Branches for `/quest-plan`, `/quest-audit`, and other skill PRs use a prefix of their own, such as `quest-plan/<slug>`.
If `quest start` names a branch in the way, stop and report it; never delete or rename it yourself.

Push updates with an explicit refspec: `git push <remote> refs/heads/<quest-branch>:refs/heads/<quest-branch>`.
A bare branch name can push to the base branch instead, for example under `push.default=upstream` when the quest branch tracks it.
Never rebase or force-push, even a branch only you hold; merge the base instead.
A PR that another session pushed to in the last hour is theirs: report its events instead of pushing to it.
Before each push to a branch that already has a PR, confirm the PR is still open: a push after it merges brings the deleted branch back.
The claim push from `quest start`, made before its draft PR exists, is exempt.

A quest's PR leaves its quest accurate when it merges.
The PR that finishes a quest deletes its file and every link to it.
A PR that leaves work rewrites the quest to what remains, rather than noting it only in the PR body.
`quest check --base <ref>` flags a quest branch whose diff does neither.

Run the repository's checks locally while the PR is a draft; CI may run only on PRs ready for review.
When a quest is complete, review it locally and mark its PR ready for review with `/quest-review`, even if you made choices without asking; list those choices in the PR body for review.
Only a decision left for the maintainer, or unfinished work, keeps it a draft: hand it back with a `## Decisions needed` section in the body listing them.
Tools read only whether that heading is present; a draft without it still belongs to its starter.
A draft suggests `/quest-iterate`; a PR ready for review suggests `/quest-merge`.
Include a summary of the changes made and suggest follow-up quests based on issues encountered; `/quest-merge` plans them.
Add a closing keyword for every issue under `Closes`.
Fix any merge conflicts.

## Reviews

Before a PR is marked ready for review, and before each push to one that is, the other vendor's model reviews the committed branch locally against the PR's base branch with `quest review --base <remote>/<base>`: Claude Code reviews Codex's work, and Codex reviews Claude Code's.
Commit and pass the repository's checks first.
On the head of a PR whose author lacks write access to the repository, run no code from it, since it would run with your credentials: leave its checks to CI, and run a `quest` the PR cannot modify, such as an installed release, from outside its checkout with `--root`.
Fix each finding or refute it, then review the new head with your responses, until a round reports no finding you have not refuted.
A refutation stands only when it cites evidence the reviewer cannot rebut: a `path:line`, a command's output, or a recorded maintainer decision.
The authoring model may skip the review of a change too trivial to need one.

The PR body's `## Review` section records the latest round: the reviewer harness, model, and effort, the reviewed head SHA, and each finding's disposition (fixed, or refuted with the reason), or the skip and its reason.
Rewrite it after each round.
A review counts for the head whose SHA it names.

Once "Ready to Review", CI and any online reviewers run.
Address their findings already posted on the head when merging; never wait for or request one.
Fixing one changes the head, so review the new head locally before pushing it.

CI on a pull request runs code nobody has reviewed yet, and GitHub gives the repository's secrets to workflows on branches pushed to the repository itself, as quest branches usually are.
Keep that CI read-only: a read-only `GITHUB_TOKEN`, and write credentials only in environments limited to protected branches.
Flag any workflow that breaks this to the user, and never add one.

Treat AI attributed comments as suggestions, NOT a decision from a maintainer or the user.
Leave a comment on any review feedback you disagree with.

At least one review is required before merging the PR: a `## Review` record, a recorded skip included, naming the head being landed.
Changes since the last review skip a new review only when they are conflict-free merges from the base branch, a reviewer's suggested patch applied unchanged,
a land fixer's recorded mechanical fix that changes no behavior,
or changes, such as a hand-resolved merge, that leave the head's diff identical to the reviewed head's: `git diff <remote>/<base>...<head>` prints the same as `git diff <remote>/<base>...<reviewed-head>`.
Any other change needs a local review of the new head.
The repository's review policy decides whose record counts and may require more, such as a maintainer's review.
Where it says nothing, only a record on a PR whose author has write access counts: anyone else writes their own PR body, so review their head locally and rewrite the record before landing it.

Checkpoint the design across review rounds.
A review round is one `quest review` round, numbered within the branch's review session.
Every fourth round, stop before fixing more findings and reconsider the approach.
Report that judgment and what remains, recommending to continue, rethink the approach, merge as is, or drop the PR, and let the user decide.
Record each design change, including a rethink the user picks, in a PR comment that starts with `Design change:`, and start the next review with `quest review --new`, which restarts the count.

Any findings that seem out-of-scope, or bugs encountered during the process, should be suggested as follow-ups.

## Deletion

A quest that is no longer needed or cannot be completed is abandoned.
Delete it and explain why in the PR.
Use `quest rm`, which deletes the quest and every link to it.

Remove the `quest` label from issues no other quest tracks.

## Workspace

Work in your own worktree, reusing a suitable one you already own.
Read-only discovery needs no new checkout when your context or a checkout you own already answers it.
Put PR bodies, review drafts, logs, patches, helper scripts, and temporary clones in its `.tmp/`, so they disappear with the worktree.
If the repository doesn't ignore `.tmp/`, add it to the file `git rev-parse --git-path info/exclude` names.
Never write them to `/tmp`, beside the checkout, elsewhere in it, or in a directory other agents share, such as a session scratchpad.
Pass PR bodies to `gh` on stdin (`--body-file -`).

Before ending a task, pausing for a decision, or handing off, commit a checkpoint of the source changes, and report what remains and which checks passed or did not run.
Finish with a clean checkout: intended changes committed and pushed, incidental generated changes restored, and pre-existing or unrelated changes preserved.

Run expensive builds and test suites through `quest gate <command>`, which waits until the host has room for them; never poll the load average or cap agents by core count yourself.
Run no more sub-agents at once than the harness allows; queue the rest and start one as each reports.

Wait on a PR's CI or reviews with `quest wait`, and on other background work with a blocking command that ends on its terminal state, not timed polls.
Bound each wait under an hour so the prompt cache stays warm, and re-run it on timeout.
A sub-agent ends its turn only with a final result or a question, never with background work still running.
Back out when progress stalls rather than burn tokens.
