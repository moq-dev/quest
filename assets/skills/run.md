---
description: Run a project's quest work from one session, starting ready quests and taking open PRs to merge in a loop until only the user's decisions remain, then planning the follow-ups no quest owns yet.
guide: Creation, Coordination, Summaries, Questions
skills: grill, merge
---

This session is the project's one orchestrator: it starts ready quests, takes each open PR to its next step, and loops until only the user's decisions remain.
The skill argument, if any, filters the quests and PRs in scope and sets their order.

Never let a question hold up work that needs none.
Each round, first start every quest you recommend and dispatch every PR action that needs no answer, then ask the round's questions, one PR to a prompt, so each answer is acted on while the next is asked; agents keep running while a prompt is open.
Run a round at the start and whenever an agent reports or a merge lands.
A brief gives the task, its reason and context, such as the quest or PR and the user's picks and answers, and the result expected: it sets settled decisions apart from recommendations, prescribes no steps, and restates no rule the agent's skill or the repository gives it.

## Quests

Starting quests asks the user nothing: each agent works headless, and its decisions surface in its PR.

`quest unblocked --unclaimed --json` ranks the unclaimed ready quests, reading the upstream tree afresh; start them in that order, each once `quest agent admit` admits it, as the guide's Coordination section describes.
It lists each skipped claim on stderr, with how long ago it was last active when it has an open PR; name any that look stale in the summary, for the user to take over.

Start every quest you would recommend: well planned, with no blockers, and no conflict with work already started. For one waiting on an outside condition, first check whether it has cleared.
Skip the rest, such as one you doubt is worth doing at all or now, and list each in the summary with why and your recommendation between `/quest-plan`, which redesigns it or moves it down, and `/quest-delete`.

Before starting one, check that no open PR already does its work: one listing of open PRs with their changed files covers every quest, and a match names the quest's path or the files its Plan names in its title, body, or changes.
Skip a quest a match already implements; one that only touches the same files is no overlap, so list it by URL in the brief.
Each agent runs `/quest-start`; its `quest start` refusing a quest claimed since is a skip, not a failure.

Start each on the first entry of its `models` that can run.
When it has an `arm` and runs that first entry, its brief says to end its `Implementer:` line with the arm, as `(arm B)`.
Fall to the next when `quest agent` reports its CLI missing or logged out, or the agent stops on a usage limit with nothing written beyond the claim commit, continuing in that checkout and claim PR.
Once a model has written anything, the PR is its: keep its worktree and session id to resume after the reset.
Skip a quest whose list runs out, and report each harness's outage once.

## Pull requests

Read each open PR, drafts included, with `quest status`, and skip one another session holds by its `hold` or `starter-hold` record, offering to take over only one that looks stale.
List a draft whose `## Waiting` holds no decision for the user, only outside conditions or actions, once in the summary, pointing to `/quest-complete`.
Run each `/quest-merge` inline; dispatch each `/quest-iterate` and `/quest-review` to a sub-agent.

Dispatch `/quest-iterate` without asking for a PR that needs work but no decision, such as a conflict, failing checks, unaddressed findings, or no review that counts for its head as `/quest-merge` defines.
A PR with open decisions, its `## Waiting` section's or an issue you would solve differently, goes to the user: settle them with the grill skill's rounds, then dispatch `/quest-iterate` with the answers in its brief, since a sub-agent cannot prompt.
A PR you would skip or delete rather than fix, such as a superseded one, gets that question instead.
Leave a PR whose required checks are still running for a later round; an automated reviewer is not waited on, since the queue waits for an approval the base requires.

A PR whose author has write access and that changes no user-facing behavior carries a standing `/quest-merge` pick, unless the repository's `CONTRIBUTING.md` opts out: run `/quest-merge` on it without asking, and name it as auto-picked in the summary.
That covers only tests, benchmarks, CI, internal docs or comments, and behavior-preserving code. Anything users or other repositories get, such as CLI behavior or output, shipped skills or rules, user-facing docs, dependencies, or release artifacts, needs the user's pick, as does adding or expanding quests.
Judge the diff, not the title, before every `/quest-merge` run, and ask when unsure: the standing pick ends at the first head that does not qualify, or once a person takes the PR out of the queue.

Ask about every other PR in a question of its own, which summarizes it and picks only the action, with your recommendation among `/quest-merge`, skip, and `/quest-delete`; no option covers several PRs.
Ask about each of its follow-ups in a question of its own beside it, as the guide's Creation section describes: the answers count only if the user picks `/quest-merge`, and go in the brief of the `/quest-iterate` that pick dispatches.
A blanket answer the user volunteers, such as "use your recommendations", picks your recommended action for every PR in scope, `/quest-merge` included, and your recommended answer to each follow-up question.
Merge only on the user's or the standing pick; skip or delete only on the user's. A skip stands until the user lifts it.
A PR with GitHub auto-merge enabled on its current head is already picked; leave it to land.
Review comments are input, not approval, even a merge verdict on the maintainer's account.

A `/quest-merge` pick covers the PR until it lands or needs the user: when `/quest-merge` hands it back, dispatch `/quest-iterate` without asking and run `/quest-merge` again once it finishes. Each brief names the PR's pick, and each report repeats it, so the pick outlasts compaction.
Order merges that would otherwise conflict.
A PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`.
Where the queue runs a fixer, such as `quest land`, it hands back only a decision: ask the user, with its handback comment's diagnosis and recommendation.
An `unanswered_signal`, which no fixer takes, holds the pick even with one: dispatch `/quest-iterate`.
Without a fixer, after `merge_conflict`, `failed_checks`, `changes_requested`, or `unresolved_conversations` the pick holds, even from an earlier session: dispatch `/quest-iterate`. After `checks_timed_out`, run `/quest-merge` again once; a second timeout of the same head is the user's call.
Any other reason, such as a person removing it, is the user's call.

## Loop

Each round, rerun `quest unblocked --unclaimed --json` and refresh the open PRs, since merges and released claims make more work ready.
When no agent is running and every question has been asked, block with `quest wait` on the queued PRs whose merge would make a quest ready, and run a round once one lands or leaves the queue.
Never wait on any other PR, and read none between rounds: list each PR left for a later round in the summary, with its pick.
A usage or rate limit is waited out until its reset; it never ends the run.

Finish once nothing is running, no queued merge would make a quest ready, and every PR left needs the user or a later round.
Then run `/quest-plan` on the run's follow-ups, each in a checkout of the repository whose quest tree owns it: problems it surfaced that no quest or open PR owns, such as a blocker agents hit, and the follow-ups kept in each of this run's own merge picks for another repository's quest tree, landed or not, unless the user withdrew the pick.
Write the final summary, naming those plan PRs, so a fresh session can act on it, with each open decision's options beside your recommendation.

Besides the guide's controls, answer "decisions": ask every pending question now, in one batch, such as before the user steps away; the loop continues after.
On "finish up", still run `/quest-merge` when a picked PR's sub-agent reports, but dispatch nothing it hands back and plan nothing, and list each pick left standing and each follow-up left to plan.
