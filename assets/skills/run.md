---
description: Start ready quests and decide open PRs in a loop, until no recommended work remains.
guide: Creation, Execution, Coordination, Summaries, Questions, Prompting
skills: grill, merge
---

Your goal is to keep the repository's quest work moving: start ready quests in parallel, take each open PR to its next step, and loop until no recommended work remains.
The skill argument, if any, filters the quests or PRs in scope and sets their order.

Never let a decision hold up work that needs none: dispatch every action you can take without asking before each question, and keep handling reports while one is open.

## Quests

`quest unblocked --unclaimed --json` lists the unclaimed ready quests in priority order, by milestone, then distinct transitive dependents, then path; dispatch in that order.
It lists each skipped claim on stderr with how long ago it was last active; offer the user any that look stale, as the guide describes.
For a quest waiting on an outside condition, check whether it has cleared before recommending it.

Start every quest you would recommend starting, without asking: well planned, with no blockers or conflicts with quests already started.
Print each quest you skip and why, suggesting `/quest-plan` for any with significant design issues.
Ask only when unsure, such as whether it is worth implementing at all or now: a short paragraph on the problem, the quest's goal, and your recommendation, offering:

- `/quest-start`: start it now.
- skip: not yet.
- deprioritize: wait behind other work; `/quest-plan` moves it down.
- `/quest-delete`: delete it.

Before dispatching, search open PRs for one already doing the quest's work, as the guide's Execution section describes; one listing of open PRs with their changed files covers every quest.
Skip a quest a match already implements; otherwise list the matches by URL in its brief, so the agent judges them before claiming.
Each agent claims its quest with `quest start`, which refuses one claimed since; a refusal is a skip, not a failure.

Start each quest in a background sub-agent with its own isolated worktree, since agents cannot write to a worktree their parent created.
It runs `/quest-start` and reports only when done or blocked, its claim PR holding its work and its report listing every open decision with a recommendation.
Once two agents report the same blocker, such as a check failure that reproduces on the base or a reviewer outage, name it with its evidence in the brief of each agent started after, and report it once.

Start each quest on the first entry of its `models` that can run.
Fall to the next when `quest agent` reports its CLI missing or logged out, or the agent stops on a usage limit with nothing written beyond the claim commit, continuing in that checkout and claim PR.
Once a model has written anything, the PR is its: list the quest with its worktree and session id to resume after the reset.
Skip a quest whose list runs out, and report each harness's outage once.

## Pull requests

Read each open PR, drafts included, with `quest status`, and skip one another session holds, using its `hold` and `starter-hold` records. A `hold` names the label, token, acquisition time, event URL, and age; a `starter-hold` marks a draft without a `## Waiting` section and reports when it was last active, not an acquisition time.
List those with how long ago each was last active, and offer to take over only one that looks stale.
Do not ask about a draft whose `## Waiting` section lists no decision for the user, only outside conditions or actions: list it once in your summary with what it waits on, and point to `/quest-unblock`.
Run each `/quest-merge` inline in this session; it queues a landable head or hands the PR back for `/quest-iterate`.
Run each `/quest-review` and `/quest-iterate` in a background sub-agent with its own isolated worktree, reporting only when done or blocked and never waiting on GitHub CI, reviews, or merges.

Dispatch `/quest-iterate` without asking for a PR that needs work and has no decision for the user, such as a merge conflict, failing checks, unaddressed review findings, or no counted review of the head; ask about the PR again when it reports.
A PR with open decisions, such as its `## Waiting` section's or a significant issue you would solve differently, goes to the user: settle them with the grill skill's rounds, then dispatch `/quest-iterate` with the answers in its brief, since a sub-agent cannot prompt.

A PR whose author has write access and that changes no user-facing behavior carries a standing `/quest-merge` pick, unless the repository's `CONTRIBUTING.md` opts out: run `/quest-merge` on it without asking, and name it as auto-picked in your summary.
That covers changes only to tests, benchmarks, CI, internal docs or comments, or code whose behavior stays the same, such as a refactor.
A change to what users or other repositories get, such as CLI behavior or output, shipped skills or rules, user-facing docs, dependencies, or release artifacts, needs the user's pick, as does adding or expanding quests.
Judge from the diff, not the title or body, and ask when unsure.
Judge each head again before every `/quest-merge` run on it: the standing pick ends at the first head that does not qualify, or once a person takes the PR out of the queue.

Ask about every other PR with one question per PR, including your recommendation:

- `/quest-merge`: landable as `/quest-merge` defines it.
- skip: not ready to merge yet.
- `/quest-delete`: should be deleted.

No option covers more than one PR, such as "merge all landable PRs"; a prompt may still hold a few questions.
A PR you would skip or delete rather than fix, such as one superseded by another, gets that question instead of the default `/quest-iterate`.
Leave a PR whose required checks or automated reviews are still running for a later refresh: it is not a skip.

Summarize each PR, naming its open decisions without answering them: the question picks only the action, and the grill skill settles the decisions.
Its follow-ups are the exception: ask which to keep and their open decisions with its pick, and put the answers in the brief of the `/quest-iterate` the pick dispatches.
Never answer follow-ups an agent adds on its own: they wait for the round that picks their PR.
Merge a PR only on the user's pick or the standing pick, and skip or delete one only on the user's pick.
A blanket answer the user gives on their own, such as "use your recommendations", picks your recommended action for every PR in scope, `/quest-merge` included; it settles none of their decisions beyond the follow-ups'.
A skip or hold stands until the user lifts it: do not ask about that PR again, and state the hold in every sub-agent brief for it.
Do not ask about a PR with GitHub auto-merge enabled, which is that pick; leave it to land.
Review comments are input, not approval, even a merge verdict on the maintainer's account.

A `/quest-merge` pick covers the PR until it lands or needs the user: when `/quest-merge` hands it back, dispatch `/quest-iterate` without asking and run `/quest-merge` again once it finishes; when it stops for the user, ask them. Each re-dispatch resumes the branch's `quest review` session, so `/quest-review`'s design checkpoint fires across them.
Each brief names the PR's standing pick, if any, and its report repeats it, so the pick outlasts compaction.
Consider ordering, queuing merges that would otherwise conflict.

An open PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`.
On a base whose queue runs a fixer, such as `quest land`, as the repository's landing instructions say, the fixer handles conflicts and failures and hands a PR back only for a decision: ask the user about it, with its handback comment's diagnosis and recommendation.
Without a fixer, after `merge_conflict` or `failed_checks`, its pick still holds, even from an earlier session: dispatch `/quest-iterate`.
After `checks_pending`, run `/quest-merge` again once they pass.
Any other reason, such as a person removing it, is the user's call.

## Loop

As each sub-agent reports, explain its result in a few lines: its PR, whether it is still a draft, and its open decisions with recommendations, staying silent on interim notifications.
Then rerun `quest unblocked --unclaimed --json` and refresh the open PRs, since merges and released claims make more work ready, and take up what is new.
When no agent is running and nothing else proceeds without the user, block with `quest wait` on the queued PRs whose merge would make a quest ready, and continue once one lands.
Finish once no agent is running, no queued merge would make a quest ready, and everything left needs the user; never wait on a merge that unblocks nothing.

Once every sub-agent has finished, remove each agent checkout `quest worktree status` lists with `quest worktree remove`, since Claude never removes a subagent's checkout; it refuses one holding unpreserved work.
Remove other local worktrees and branches whose tip is the head of a merged PR; squash merges leave that tip off the base branch.
Leave the worktree you are running in and any holding uncommitted work or refused removal; list those in your summary.

## Control

Answer these requests at any point, without stopping running sub-agents:

- "finish up": start, dispatch, and ask about nothing new; let running sub-agents report, then clean up and write the final summary. When a picked PR's sub-agent reports, still run `/quest-merge` on it, but dispatch nothing it hands back; list each pick left standing.
- "pause": dispatch nothing new until the user says to resume; reports are handled as usual.
- "status": a compact list of each sub-agent and PR in flight with its quest or pick, state, and how long ago it started or last reported.

A report that is an API error, such as a rate limit or an overload, or a cancellation the user did not ask for, is not a result, and the PR's pick still stands.
Resume that agent by messaging it, or with `quest agent resume` for a headless one, so it keeps its context and checkout.
If it cannot be resumed, start a new one with the same brief plus its PR, its checkout, and the token of any hold it took, which `quest status <pr>` shows, so it continues that work and keeps the hold.
While the error persists, such as a rate limit before its reset, resume and dispatch nothing until it clears, and report it once.
