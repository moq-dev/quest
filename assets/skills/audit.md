---
description: Audit and fix outstanding quests for disagreements, conflicts, misaligned priorities, and stale plans. Use when the user invokes /quest-audit or asks to audit and fix the quest tree.
guide: Model, Format, Creation, Deletion, Summaries
skills: plan
---

The goal is a quest tree that agrees with itself and the code, with each quest in the milestone its priority calls for.
The scope is every outstanding quest, or the quests and epics the argument names.

Look for:
- Disagreements: quests whose goals or plans contradict each other, the code, or the repository's docs.
- Conflicts: quests that would change the same code or interface incompatibly, or that must land in order without a `Required` link.
- Misaligned priorities: a quest placed in a milestone ahead of work it depends on, or behind work it blocks.
- Stale plans: work already done, blockers that have cleared, or references to code that no longer exists.
- Obsolete quests: a problem that is no longer real, or a plan a later change or decision has made the wrong solution.

Split the reading across parallel sub-agents, each given a slice of the scope and returning its findings with evidence (a path, line, or commit).

Apply factual corrections and changes the user has already decided. Moving a quest between milestones is always the user's decision, never a factual correction. Use `/quest-plan` only for unresolved scope, priority, API, or other consequential choices; recommendations are not decisions. Once those choices are settled, apply them without another approval round.

Move and delete quests with `quest mv` and `quest rm`, which update the links to them; edit any mentions they report and run `quest check`. Open the PR as the plan skill does, on a `quest-audit/<slug>` branch. Report the changes with their evidence and any decisions still open. An explicit read-only audit request leaves the tree unchanged.
