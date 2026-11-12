---
description: Decide which open PRs to merge and settle what quests and drafts wait on, then queue the merges.
guide: Summaries
skills: run
---

Run only the Pull requests part of `/quest-run` below, with its loop's rounds, and settle the waits: refresh the open PRs and waits as sub-agents report, and stop once every PR and wait in scope is decided and every sub-agent has reported.
Start no quests, and wait on no PR.

## Waits

`quest waiting --json` lists each quest's and draft's `## Waiting` items, the maintainer's first, ranked by what each unblocks; if it warns that drafts were skipped, restore GitHub access and rerun it.

Check every item's condition yourself, never asking the user, several at once in sub-agents.
Remove an item that has cleared, and `quest rm` a quest that only waited on it; a draft's `/quest-iterate` brief names its cleared items.
An outside party's item that still holds stays, unless the user can advance it, such as by asking upstream for a release; then ask about that.

Ask each remaining maintainer item among the round's questions, in that order, saying what it unblocks.
For an action only the user can take, give the exact steps and the check you will run once they report it done.
Settle a draft's items with its PR.
Record a quest's answer and reason in its Plan as `Decided <date> (maintainer, /quest-complete): ...`, removing the item, or delete a quest that only waited on it and record the decision in the PR body's `## Decisions`.

Make every quest edit in one draft PR on a `quest-complete/<slug>` branch, after `quest check`, and run `/quest-review` on it; it is then in scope like any PR.
The final summary lists each wait settled, cleared, or still held, with who acts and what its check found.
