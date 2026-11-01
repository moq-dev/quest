---
description: Decide which open PRs to merge, then queue them.
---

Before starting, run `quest guide`, `quest skill review`, `quest skill merge`, and `quest skill plan`.

The goal is to evaluate the open PRs in the repository, drafts included, and decide which ones to merge.
For a draft, summarize the open decisions its body lists.
Read each PR with `quest status` and skip one another session holds, using its `hold` and `starter-hold` records instead of a separate label read. A `hold` names the label, acquisition token/time, event URL, and age. A `starter-hold` identifies a draft without a `## Decisions needed` section and reports when it was last active; that is not an acquisition time.
List those with how long ago each was last active, and offer to take over only one that looks stale.
The skill argument can be used to filter the PRs in scope.
Run each `/quest-merge` inline in this session; it only queues a reviewed head or recommends `/quest-iterate`.
Run each `/quest-review` and `/quest-iterate` in parallel in a sub-agent, following the guide's Reviews section for the shared design checkpoint across review rounds.

Ask synchronously with one question per PR, never grouping PRs into one question (a prompt may hold a few questions), following the guide's Questions section and including your recommendation:
- `/quest-review`: Are drafts ready for review.
- `/quest-merge`: Are ready for review and landable as `/quest-merge` defines it: a review the guide counts on the head, required status checks passed, and every automated review finding on GitHub fixed or refuted.
- `/quest-iterate`: Have failing checks, unaddressed review findings, other issues, or decisions, or have no counted review of the head.
- skip: Are not ready to be merged yet.
- `/quest-delete`: Should be deleted.

Do not ask yet about a PR whose required checks or automated reviews are still running: it is not a skip, so ask about it on a later refresh once they finish.

Include a brief summary of each PR.
Act on a PR only after the user picks its action in this session, including PRs found on a later refresh.
A blanket answer, such as "accept all" or "use your recommendations", picks your recommendation for every PR in scope, `/quest-merge` included, except a PR whose recommendation settles a decision you have not yet shown; ask about those.
A skip or hold stands until the user lifts it: do not ask about that PR again on a refresh, and state the hold in every sub-agent brief for it.
GitHub auto-merge is that pick: enabling it takes write access, and GitHub disables it when anyone without write access pushes.
Do not ask about a PR with auto-merge enabled; leave it to land.
A pick covers the PR until it lands or needs the user: when `/quest-merge` recommends `/quest-iterate` for a picked PR, dispatch it without asking, and run `/quest-merge` again when it reports; when a push draws new review findings, send it back the same way. The guide's design checkpoint counts rounds from the PR, so it fires across those re-dispatches.
Review comments are input, not approval, even a merge verdict on the maintainer's account.
Consider ordering, queuing any merges if they would result in conflicts.

Run each `/quest-review` or `/quest-iterate` in its own sub-agent with its own isolated worktree.
Each sub-agent reports back only when done or blocked, and never waits on GitHub CI, reviews, or merges.

Do not watch the queue or wait for merges.
An open PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`.
After `merge_conflict` or `failed_checks`, its pick still holds, even from an earlier session: dispatch `/quest-iterate` without asking, then run `/quest-merge` when it reports.
After `checks_pending`, or a pick `/quest-merge` left for pending checks, run `/quest-merge` again on a later refresh once they pass.
Any other reason, such as a person removing it, is the user's call, so ask about the PR again.

Keep going until all PRs have been decided, then wait for all spawned sub-agents to finish.
Refresh the open PR list whenever a sub-agent reports, and once more before finishing; ask about each new PR in scope the same way.

As each sub-agent reports, include a summary and interactively prompt the user for any outstanding decisions.
Collect each queued PR's suggested follow-ups, and once every sub-agent has finished, plan them as the guide describes; each interview lets the user drop its follow-up.
Dispatch already selected actions before asking the next question; background work can continue while the foreground waits.

Once every sub-agent has finished, remove local worktrees and branches whose tip is the head of a merged PR; squash merges leave that tip off the base branch.
Leave the worktree you are running in and any holding uncommitted work; list those in your summary.
