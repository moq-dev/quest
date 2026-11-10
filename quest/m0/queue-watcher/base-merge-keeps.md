# [M] The tested-base merge keeps the base's content

## Goal

`mergeBase` (`src/cli/land.ts`) never removes content that both the PR head
and the base still have. The commit it pushes to a PR's branch differs from
the base only by the PR's own changes, plus the links it drops to quests the
base finished. A test merges a base that finished one quest into a head that
touches an unrelated README, and finds every other line of every quest file
unchanged.

## Plan

Planned 2026-11-10 (maintainer, /quest-complete in moq-dev/moq). Milestone:
✅ m0, in this epic (rejected: m0 standalone, m1), since it hit moq-dev/moq's
queue today.

On [moq-dev/moq#8429](https://github.com/moq-dev/moq/pull/8429), the bot's
`quest land: merge tested base` commit `74d26316c6` has parents `8f0fee87e5`
(the PR head) and `5e962fc7f1` (the base, on `main`). Against that base it
deletes 669 lines in 45 files: every quest README's `## Required` list
(`quest/README.md`, `quest/m0` through `quest/m5`, and epic READMEs), plus
the PR's own changes. The head, the base, and their merge base `cd560bde5e`
all have those lists, so no conflict explains it. The base had just finished
one quest ([moq-dev/moq#8427](https://github.com/moq-dev/moq/pull/8427)
deleted `quest/m0/nightly/qmux-bench-handshake.md`), so `prune` ran; it is
the prime suspect, with the `quest resolve` merge driver next. Reproduce from
those three commits before fixing.

An iterating agent caught it by hand and restored `quest/` from `main`. A
head like this one can otherwise land, since `quest check` passes on a tree
whose READMEs list nothing.

Public API: none. Wire: none.
