---
description: Walk the maintainer through every quest and draft PR waiting on them, and clear waits that have resolved.
---

Before you begin, run `quest guide`, `quest skill grill`, and `quest skill plan`, and read their output completely.

The goal is to unblock the most work for each thing the maintainer settles, and to clear every wait whose condition has already resolved.
The skill argument, if any, filters the quests or PRs in scope.

Gather what waits:

- `quest waiting --json` lists each quest's `## Waiting` items and each draft PR's hand-back items, the maintainer's first, ranked by what each unblocks; a draft's entry carries its URL in `pr`. If it warns that drafts were skipped, restore GitHub access and rerun it rather than go on without them. Check each draft's holds with `quest status <pr>`, and skip one another session holds as `/quest-complete` does.
- Quests that wait in prose without the section, such as a Goal opening "Waiting on the maintainer" or "Waits on moq-dev/moq". Rewrite each into a `## Waiting` section in this skill's PR, and treat it like the rest.

Checking a condition is your job, never the user's. Check every item yourself, outside parties' and the maintainer's alike: run its check, or dispatch sub-agents to run several at once.
A condition that has cleared needs no question: remove its item, or delete a quest that only waited on it, with `quest rm`.
An outside party's item that still holds stays, unless the maintainer can advance it, such as by asking upstream for a release; then offer that as a question.

Put every remaining maintainer item to the user with the grill skill's rounds, in `quest waiting`'s order.
Each question says what it unblocks, the context needed to answer without opening the quest or PR, and the options with your recommendation.
For an action only the user can take, such as opening an account or granting access, give the exact steps and the check you will run; when they report it done, run the check before treating it as cleared.
Collect any secret through the host's secret prompt, never in chat.
A skip stands for this session; leave that item as it is.

Record each answer where its wait lives:

- **Quest:** record the decision and its reason in the quest's Plan, as `Decided <date> (maintainer, /quest-unblock): ...`, and remove the item. Delete a quest whose only purpose was the wait.
- **PR:** dispatch `/quest-iterate` in a sub-agent with its own worktree, with the answers in its brief. It applies them, runs the PR's reviews, and leaves merging to the user's pick through `/quest-merge` or `/quest-complete`.

Make every quest edit in one PR on a `quest-unblock/<slug>` branch, run `quest check`, open it as a draft, and run `/quest-review` on it, which reviews the branch, marks the PR ready, and offers its merge picks; merging it waits on the user's pick, like any PR.

End with the final summary the guide describes, covering:

- what was settled, cleared, or deleted;
- the PRs and the sub-agents dispatched;
- each item still waiting, with who acts and what its check found.
