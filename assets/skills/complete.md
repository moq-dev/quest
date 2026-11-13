---
description: Decide which open PRs to merge and settle what quests and drafts wait on, queue the merges, then plan the run's follow-ups.
guide: Format, Deletion, Summaries
skills: run
---

Run only `/quest-run`'s Pull requests part below with its loop's rounds, plus the waits: refresh both as sub-agents report, and stop once all have reported and every PR and wait in scope is decided, skipped, or left to an outside party, then plan its follow-ups and write the summary as the loop's finish describes.
Start no quests, and wait on no PR.
The skill argument, if any, filters the PRs and waits in scope.

## Waits

Take the quests' and drafts' `## Waiting` items from `quest waiting --json`, which ranks them; rerun it with GitHub access if it warns that drafts were skipped, and skip a draft another session holds, as for PRs.
Rewrite a quest that waits in prose, such as a Goal opening "Waiting on the maintainer", into a `## Waiting` section, and treat it like the rest.
Check each condition yourself, in parallel sub-agents.
An outside party's item that holds stays, asked about only when the user can advance it, such as by requesting an upstream release.
Ask each maintainer item left among the round's questions, in that order, saying what it unblocks; a skip stands for the session.
For an action only the user can take, give the exact steps and the check you will run once they report it done; take any secret through the host's secret prompt.

Settle a draft's items with its PR, naming cleared ones in its `/quest-iterate` brief.
Remove a quest's cleared item, or its answered one after recording the answer and reason in its Plan as `Decided <date> (maintainer, /quest-complete): ...`; `quest rm` a quest whose only purpose was that wait, editing the mentions it reports and recording why and any answer in the PR body's `## Decisions`, and drop the `quest` label from issues no other quest tracks.
Make these edits in one draft PR on a `quest-complete/<slug>` branch, run `quest check` on the edited tree, then `/quest-review`; it is then in scope like any PR.
The final summary lists the waits settled, cleared, or deleted, and each still held, with who acts and its check's result.
