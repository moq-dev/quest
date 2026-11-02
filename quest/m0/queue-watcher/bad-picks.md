# [M] The watcher fixes a pick GitHub refuses to enqueue

## Goal

A picked PR that GitHub refuses to enqueue, because it conflicts with the
base or otherwise can't merge, is fixed by the watcher instead of handed back.
The watcher merges the base into it locally with the quest merge driver; a
clean merge is pushed and enqueued. When the local merge still conflicts, or
the PR's own required checks fail, the fixer resolves it with the conflicting
paths or the failing checks' logs, and the watcher pushes and enqueues the
result. The PR reaches a person only on a handback. The watcher never trusts
GitHub's mergeability flag alone.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)):

- Picks GitHub refuses to enqueue:
  - ✅ The watcher fixes them, including conflicts resolved with the quest
    merge driver, then pushes and enqueues
  - Hand them back

This quest was the host gate's local mergeability quest, decided 2026-10-31
(user, /quest-plan of the follow-ups from a moq-dev/moq `/quest-complete`
run): GitHub reported conflicts on
[moq-dev/moq#7407](https://github.com/moq-dev/moq/pull/7407), which merges
cleanly, and on [moq-dev/moq#7382](https://github.com/moq-dev/moq/pull/7382),
whose only conflict was in quest link lists, which the driver resolves. It
also absorbs the host gate's plan to park a PR whose own required CI fails for
the fixer with the failing check's log (decided 2026-11-01, settling
[moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)'s decision 8),
since on a merge-queue base such a PR is a pick GitHub won't enqueue.

- The watcher learns of refused picks from the marker
  [Picks enter the merge queue](/quest/m0/queue-watcher/pick.md) records, and
  from picks whose auto-merge stays armed while the PR is conflicting or its
  required checks failed.
- Merge locally with `mergeBase` (`src/cli/land.ts`), which already uses the
  driver; the host gate's `prepareHead` (`src/cli/land-head.ts`) shows the
  push. A clean driver merge needs no review: it is a conflict-free base merge.
- Fetch failing required checks' logs through the App's `checks: read` and
  `actions: read`, trimmed like a queue failure's.
- The same stop rules apply (`stopRule` in `src/cli/land-fixer.ts`).

## Required

- [Fix and re-enqueue](/quest/m0/queue-watcher/fix.md) - the fixer path and re-enqueue this reuses
- [Picks enter the merge queue](/quest/m0/queue-watcher/pick.md) - the pick marker a refused pick leaves
