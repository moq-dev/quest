# [L] Epics list no children

## Goal

An epic's children are the quests in its directory, and its `Required`
section lists only the work that blocks it. Finishing a quest deletes its
file and edits no epic or milestone README, so PRs that finish sibling
quests stop conflicting. `quest check --fix` strips the old child lists from
a repository's tree.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) audit).

Measured, moq-dev PRs created 2026-10-06 to 11-05:

- `quest/m1/README.md` was touched by 33% of merged moq-dev/moq PRs, and
  milestone READMEs as a group by 45%; in moq-dev/rust2, `quest/m3/README.md`
  by 290 of 585.
- GitHub's merge queue cannot run quest's merge driver and ejected 723 PRs
  for conflicts. The [queue watcher](/quest/m0/queue-watcher/README.md)
  re-merges such a PR with the driver since
  [moq-dev/quest#389](https://github.com/moq-dev/quest/pull/389), but each
  ejection still costs a requeue and a CI run, and the rate after 11-01
  stayed at 0.13 per merged PR.

Decision prompts, chosen options marked ✅:

- Ordering: ✅ drop the ordering. The maintainer proposed it.
  `quest unblocked` already ranks by milestone, then downstream impact, and
  only then by list order (`src/core/unblocked.ts`), so order is only a
  tiebreak. Path order replaces it.
- Scope: ✅ every epic (rejected: milestones only; unordered lists). The
  directory already is the tree and `Required` already holds blockers, so
  epics stay the graph they are minus the copy of the directory. A child
  that must precede a sibling becomes an explicit blocker in `Required`.
  Parallel siblings spawned from one epic conflict on its README today, as
  milestones do.

The guide's Model, Format, and Creation sections, the skills that rank or
place work (`/quest-plan`, `/quest-audit`, `/quest-spawn`,
`/quest-recurring`, `/quest-import`), and `quest tree`'s output change with
it. The merge driver keeps resolving the blocker lists that remain.
