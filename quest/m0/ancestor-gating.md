# [S] Epics and milestones gate the quests under them

## Goal

A quest is ready only when neither it nor any epic above it, milestones
included, has a `## Required` section, so m3's README can require the quest
that cuts m2 and nothing in m3 starts until that lands. `quest unblocked` and
`--json` leave such quests out, `quest unblocked <path>` names the ancestor and
its blockers, `quest waiting`'s ready flag agrees, and the guide's Format and
Execution sections say so.

## Plan

Decided 2026-11-08 (maintainer, `/quest-plan` in moq-dev/kixel.ai, planning
its software factory): ✅ "Recurse to all of the parents to see if they are
blocked" (rejected: a milestone horizon in the factory's own config; both).
Why: the gate lives in the tree, so `/quest-spawn`, the factory, and every
teammate obey the same one with no separate config. It replaces the
maintainer's habit of spawning "anything in m0/m1" by hand.

- An epic's `## Required` already never lists its own quests (`quest check`
  reports one and `--fix` drops it), so an ancestor's blockers lie outside it.
  Cycle detection must still count the ancestor edges: a blocker that waits on
  a quest under the epic requiring it is a cycle.
- Ranking: requiring a quest from an epic holds back everything under that
  epic, so `quest unblocked`'s impact counts those quests as the blocker's
  dependents, milestones included, which `permanent` excludes today.
- A milestone stays finished once its directory holds no other quest and its
  README has no `## Required`, as now.

Tests: a quest under an epic with `## Required` is not listed until the entry
goes; the same two levels down and under a milestone; `quest unblocked <path>`
prints the ancestor's chain; a cycle through an ancestor is reported; and the
blocker's impact counts the quests it holds back.
