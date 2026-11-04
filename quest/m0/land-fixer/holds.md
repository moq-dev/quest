# [S] The land fixer leaves a held PR alone

## Goal

`quest land watch` neither runs the fixer on a PR another session holds, nor
pushes a fixer result to it or re-enqueues it. A hold is any hold label
`isHoldLabel` accepts (`src/core/hold.ts`), such as the `quest:active` that
`/quest-iterate` takes, or an older pin's `quest:iterate`. The watcher
checks for a hold before it starts a job and again before it pushes or
re-enqueues. A held PR gets one comment saying the watcher left it to the
session that holds it.

Non-goals: the frozen batching gate (`quest land serve`), which only
moq-dev/moq.pro still uses until it is
[retired](/quest/m0/queue-watcher/retire.md).

## Plan

Decided 2026-11-03 (maintainer, /quest-complete on moq-dev/moq, planned
through moq-dev/moq's coordinator): plan this follow-up. Milestone: m0,
under the land fixer epic. moq-dev/moq lands through this fixer every day,
and m0's Plan ranks the land work first.

What happened on
[moq-dev/moq#6949](https://github.com/moq-dev/moq/pull/6949): the
maintainer added `quest:iterate` at 2026-11-01 16:41Z for a `/quest-iterate`
session. The fixer still pushed its merge `7c10f33cbc` at 16:52Z, and moq-bot
re-armed `quest:merge` at 16:56Z, while the session was pushing its own
fixes on the same branch. The hold was lifted at 17:22Z. That was the host
gate. `quest land watch`, which replaced the gate on moq-dev/moq, has the
same gap: `src/cli/land-watch.ts` and `src/cli/land-watch-fix.ts` never read
the PR's labels for holds.

Implementation guidance:

- Read the hold labels with the snapshot the watcher already takes for each
  PR the queue drops, and again right before a result is pushed or the PR is
  re-enqueued, so a hold taken while the fixer runs is respected too.
- Open question for the starter: what happens to the pick of a held PR?
  Recommended: the hold ends it, as a person's removal from the queue does
  (`endPick`). A maintainer enqueues the PR again once its session finishes,
  as `/quest-iterate`'s `/quest-merge` hand-off already does. The other
  option is to wait and fix it once the hold clears, but by then the session
  has usually pushed, and a push by anyone but the fixer already ends the
  pick.
- Add a regression test: a PR the queue drops while it holds `quest:active`
  is neither fixed nor re-enqueued.
