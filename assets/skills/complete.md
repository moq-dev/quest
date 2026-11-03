---
description: Decide which open PRs to merge, then queue them.
---

Before starting, run `quest guide`, `quest skill grill`, `quest skill review`, `quest skill merge`, and `quest skill plan`.

The goal is to evaluate the open PRs in the repository, drafts included, and decide which ones to merge.
For a draft, summarize the open decisions its body lists.
Read each PR with `quest status` and skip one another session holds, using its `hold` and `starter-hold` records instead of a separate label read. A `hold` names the label, acquisition token/time, event URL, and age. A `starter-hold` identifies a draft with neither a `## Waiting` section nor the older `## Decisions needed` and reports when it was last active; that is not an acquisition time.
List those with how long ago each was last active, and offer to take over only one that looks stale.
Do not ask about a draft whose `## Waiting` section, or the older `## Decisions needed`, lists no decision for the user, only outside conditions or actions someone must take: list each once in your summary with what it waits on, and point to `/quest-unblock`.
The skill argument can be used to filter the PRs in scope.
Run each `/quest-merge` inline in this session; it queues a landable head, or hands the PR to `/quest-iterate`.
Run each `/quest-review` and `/quest-iterate` in parallel in a sub-agent, following the guide's Reviews section for the shared design checkpoint across review rounds.

`/quest-iterate` is the default for a PR that needs work: dispatch it without asking when the PR has no decision for the user, such as for a merge conflict, failing checks, unaddressed review findings, or no counted review of the head.
It fixes the PR, reviews it, and marks it ready; ask about the PR again when it reports.
A PR with open decisions, such as those its `## Waiting` section lists or a significant issue you would solve differently, goes to the user instead: settle its decisions with the grill skill's rounds, then dispatch `/quest-iterate` with the answers in its brief.

Ask about every other PR synchronously with one question per PR, never grouping PRs into one question (a prompt may hold a few questions), following the guide's Questions section and including your recommendation:
- `/quest-merge`: Are landable as `/quest-merge` defines it.
- skip: Are not ready to be merged yet.
- `/quest-delete`: Should be deleted.

A PR you would skip or delete rather than fix, such as one superseded by another, gets that question instead of the default `/quest-iterate`.
Leave a PR whose required checks or automated reviews are still running for a later refresh once they finish: it is not a skip.

Include a brief summary of each PR, naming its open decisions without answering them: the question picks only the action, and the grill skill settles the decisions.
Merge, skip, or delete a PR only after the user picks that in this session, including PRs found on a later refresh.
A blanket answer, such as "accept all" or "use your recommendations", picks your recommended action for every PR in scope, `/quest-merge` included; it settles none of their decisions.
A skip or hold stands until the user lifts it: do not ask about that PR again on a refresh, and state the hold in every sub-agent brief for it.
GitHub auto-merge is that pick: enabling it takes write access, and GitHub disables it when anyone without write access pushes.
Do not ask about a PR with auto-merge enabled; leave it to land.
A `/quest-merge` pick covers the PR until it lands or needs the user: when `/quest-merge` hands the PR to `/quest-iterate`, dispatch it without asking, and run `/quest-merge` again once it finishes; when it stops for the user instead, as `/quest-merge` describes, take that to the user. When a push draws new review findings, send it back the same way. Each re-dispatch resumes the branch's `quest review` session, whose rounds the guide's design checkpoint counts, so it fires across them.
When a `/quest-iterate` that no `/quest-merge` pick covers reports, ask about the PR again.
Review comments are input, not approval, even a merge verdict on the maintainer's account.
Consider ordering, queuing any merges if they would result in conflicts.

Run each `/quest-review` or `/quest-iterate` in its own sub-agent with its own isolated worktree.
A sub-agent cannot prompt, so settle a PR's decisions for the user here with the grill skill's rounds before dispatching `/quest-iterate` for it, whatever dispatches it.
Each sub-agent reports back only when done or blocked, and never waits on GitHub CI, reviews, or merges.

Do not watch the queue or wait for merges.
An open PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`.
On a base whose queue runs a fixer, such as `quest land`, or `quest land watch` beside GitHub's merge queue, as the repository's landing instructions say, the fixer resolves conflicts and failures itself and hands a PR back only when a decision is needed, so do not run `/quest-merge` again for a PR that queue dropped: ask the user about it, with the diagnosis and recommendation from the fixer's handback comment.
Without a fixer, after `merge_conflict` or `failed_checks`, its pick still holds, even from an earlier session: dispatch `/quest-iterate` as for any `/quest-merge` pick.
After `checks_pending`, or a pick `/quest-merge` left for pending checks, run `/quest-merge` again on a later refresh once they pass.
Any other reason, such as a person removing it, is the user's call, so ask about the PR again.

Keep going until all PRs have been decided, then wait for all spawned sub-agents to finish.
Refresh the open PR list whenever a sub-agent reports, and once more before finishing; ask about each new PR in scope the same way.

As each sub-agent reports, include a summary; its outstanding decisions go to the grill skill's rounds before its next `/quest-iterate` dispatch, never into a pick question.
Collect each queued PR's suggested follow-ups, and once every sub-agent has finished, plan them as the guide describes.
Dispatch already selected actions before asking the next question; background work can continue while the foreground waits.

Once every sub-agent has finished, remove local worktrees and branches whose tip is the head of a merged PR; squash merges leave that tip off the base branch.
Leave the worktree you are running in and any holding uncommitted work; list those in your summary.

## Control

Answer these requests at any point, without stopping running sub-agents:

- "finish up": ask about no new PR and dispatch nothing new, plan the follow-ups collected so far and each later one as its sub-agent reports, let running sub-agents report, then clean up and write the final summary. When a picked PR's sub-agent reports, still run `/quest-merge` on it, but dispatch nothing it hands back; list each pick left standing in the summary.
- "pause": dispatch nothing new until the user says to resume; running sub-agents continue, and their reports are handled as usual.
- "status": a compact list of each sub-agent and PR in flight with its pick, state, and how long ago it was dispatched or last reported.

A report that is an API error, such as a rate limit or an overload, or a cancellation the user did not ask for, is not a result, and the PR's pick still stands.
Resume that sub-agent by messaging it, so it keeps its context and checkout.
If it cannot be resumed, dispatch a new sub-agent with the same brief plus the token of the hold it took on the PR, which `quest status <pr>` shows, so the new one keeps that hold rather than releasing it.
While the error persists, such as a rate limit before its reset, resume and dispatch nothing until it clears, and report it once rather than per sub-agent.
