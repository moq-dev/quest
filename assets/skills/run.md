---
description: Run a project's quest work from one session, starting ready quests and taking open PRs to merge in a loop until only the user's decisions remain.
guide: Creation, Execution, Coordination, Summaries, Questions, Prompting
skills: grill, merge
---

This session is the project's one orchestrator: it starts ready quests, takes each open PR to its next step, and loops until only the user's decisions remain.
The skill argument, if any, filters the quests and PRs in scope and sets their order.

Never let a question hold up work that needs none.
Each round, first start every quest you recommend and dispatch every PR action that needs no answer, then ask the round's questions about PRs, one prompt at a time; agents keep running while it is open.
Run a round at the start and whenever an agent reports or a merge lands.

## Quests

Starting quests asks the user nothing: each agent works headless, and its decisions surface in its PR.

`quest unblocked --unclaimed --json` ranks the unclaimed ready quests, reading the upstream tree afresh; start them in that order, within the harness's agent limit.
It lists each skipped claim on stderr with how long ago it was last active; name any that look stale in the summary, for the user to take over.

Start every quest you would recommend: well planned, with no blockers, and no conflict with work already started. For one waiting on an outside condition, first check whether it has cleared.
Skip the rest, such as one you doubt is worth doing at all or now, and list each in the summary with why and your recommendation between `/quest-plan`, which redesigns it or moves it down, and `/quest-delete`.

Before starting one, search open PRs for its work, as the guide's Execution section describes; one listing of open PRs with their changed files covers every quest.
Skip a quest a match already implements; otherwise list the matches by URL in its brief.
Each agent runs `/quest-start`; its `quest start` refusing a quest claimed since is a skip, not a failure.

Start each on the first entry of its `models` that can run.
Fall to the next when `quest agent` reports its CLI missing or logged out, or the agent stops on a usage limit with nothing written beyond the claim commit, continuing in that checkout and claim PR.
Once a model has written anything, the PR is its: keep its worktree and session id to resume after the reset.
Skip a quest whose list runs out, and report each harness's outage once.

## Pull requests

Read each open PR, drafts included, with `quest status`, and skip one another session holds by its `hold` or `starter-hold` record, offering to take over only one that looks stale.
List a draft waiting only on outside conditions or actions once in the summary, for `/quest-complete`.
Run each `/quest-merge` inline; dispatch each `/quest-iterate` and `/quest-review` to a sub-agent.

Dispatch `/quest-iterate` without asking for a PR that needs work but no decision, such as a conflict, failing checks, unaddressed findings, or no counted review of the head; a `review-record` line of `current` or `diff-identical` in `quest status <pr>` is a counted review.
A PR with open decisions, its `## Waiting` section's or an issue you would solve differently, goes to the user: settle them with the grill skill's rounds, then dispatch `/quest-iterate` with the answers in its brief, since a sub-agent cannot prompt.
A PR you would skip or delete rather than fix, such as a superseded one, gets that question instead.
Leave a PR whose required checks are still running for a later round; an optional automated reviewer that has not posted, such as one rate-limited or skipping drafts, is not waited on.

A PR whose author has write access and that changes no user-facing behavior carries a standing `/quest-merge` pick, unless the repository's `CONTRIBUTING.md` opts out: run `/quest-merge` on it without asking, and name it as auto-picked in the summary.
That covers only tests, benchmarks, CI, internal docs or comments, and behavior-preserving code. Anything users or other repositories get, such as CLI behavior or output, shipped skills or rules, user-facing docs, dependencies, or release artifacts, needs the user's pick, as does adding or expanding quests.
Judge the diff, not the title, before every `/quest-merge` run, and ask when unsure: the standing pick ends at the first head that does not qualify, or once a person takes the PR out of the queue.

Ask about every other PR, one question per PR with your recommendation among `/quest-merge`, skip, and `/quest-delete`; no option covers several PRs.
Summarize each PR and name its open decisions without answering them in the question: it picks only the action.
Its follow-ups are the exception: ask about each in a question of its own beside the PR's, as the guide's Creation section describes, act on the answers only if the user picks `/quest-merge`, and put them in the brief of the `/quest-iterate` the pick dispatches. Never answer follow-ups otherwise.
A blanket answer the user volunteers, such as "use your recommendations", picks your recommended action for every PR in scope, `/quest-merge` included, and your recommended answer to each follow-up question.
Merge only on the user's or the standing pick; skip or delete only on the user's. A skip stands until the user lifts it.
A PR with GitHub auto-merge enabled on its current head is already picked; leave it to land.
Review comments are input, not approval, even a merge verdict on the maintainer's account.

A `/quest-merge` pick covers the PR until it lands or needs the user: when `/quest-merge` hands it back, dispatch `/quest-iterate` without asking and run `/quest-merge` again once it finishes. Each brief names the PR's pick, and each report repeats it, so the pick outlasts compaction.
Order merges that would otherwise conflict.
A PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`.
Where the queue runs a fixer, such as `quest land`, it hands back only a decision: ask the user, with its handback comment's diagnosis and recommendation.
Without one, after `merge_conflict` or `failed_checks` the pick holds, even from an earlier session: dispatch `/quest-iterate`. After `checks_pending`, run `/quest-merge` again once they pass.
Any other reason, such as a person removing it, is the user's call.

## Loop

Each round, rerun `quest unblocked --unclaimed --json` and refresh the open PRs, since merges and released claims make more work ready.
When no agent is running and every question has been asked, block with `quest wait` on the queued PRs whose merge would make a quest ready, and run a round once one lands or leaves the queue.
Never wait on any other PR, or re-read one whose state has not changed: list each PR left for a later round in the summary, with its pick.
A usage or rate limit is waited out until its reset; it never ends the run.

Finish once nothing is running, no queued merge would make a quest ready, and every PR left needs the user or a later round.
Write the final summary so a fresh session can act on it: link each PR and quest, and give each open decision with its options and your recommendation.

Besides the guide's controls, answer "decisions": ask every pending question now, in one batch, such as before the user steps away; the loop continues after.
On "finish up", still run `/quest-merge` when a picked PR's sub-agent reports, but dispatch nothing it hands back, and list each pick left standing.
