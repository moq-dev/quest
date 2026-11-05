# [S] Base merges only when needed

## Goal

A PR branch merges its base only when it conflicts with it or GitHub refuses
to enqueue it. `quest merge` enqueues a head that is behind the base on a
base that lands through GitHub's merge queue, since the queue tests every
PR against the live base.

## Plan

Decided 2026-11-05 (user, /quest-plan, the
[token waste](/quest/m0/token-waste/README.md) audit).

Measured, moq-dev PRs created 2026-10-06 to 11-05: 16,013 of 48,907 commits
(33%) were base merges, 48% on merged PRs and 70% in moq.pro, rising from 2.6
to 3.4 per merged PR after 11-01. Many moq CI runs were cancelled (1,527 of
5,735 PR runs), most likely superseded by the next push or base merge.

`/quest-merge` says `quest merge` refuses a head that does not contain the
current base, which sends agents to `/quest-iterate` to merge it before
every queue attempt. That preflight came from
[moq-dev/quest#253](https://github.com/moq-dev/quest/pull/253) on 10-28,
before repositories moved to GitHub's merge queue.

Decision prompts, chosen options marked ✅:

- Merge churn: ✅ the watcher merges quest files, and agents merge the base
  only on a real conflict or at queue time (rejected: stop editing READMEs,
  which epics listing no children, from
  [moq-dev/quest#518](https://github.com/moq-dev/quest/pull/518), now does
  a cleaner way; membership from directories, adopted there too). The
  watcher half already exists: it merges a dropped PR's conflict with the
  quest merge driver before using a fixer slot
  ([moq-dev/quest#389](https://github.com/moq-dev/quest/pull/389)).

Keep the preflight on bases that land through `quest land`, if any remain,
and check what #253 guarded against before removing it on queue bases.
