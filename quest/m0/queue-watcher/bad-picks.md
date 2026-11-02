# [S] The watcher enqueues an armed pick GitHub never queued

## Goal

A PR on a merge-queue base whose auto-merge a writer armed, as
`quest merge --land` does while required checks are pending, and that is now
ready (its required checks passed and it doesn't conflict) but still not in
the queue, is enqueued by the watcher at the head auto-merge was armed on.
Since about 2026-09-10 GitHub often leaves such PRs out of the queue
([community#209348](https://github.com/orgs/community/discussions/209348)),
while `enqueuePullRequest` works. A head pushed since by anyone but the fixer
is not enqueued.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)), narrowing this quest from fixing
every pick GitHub refuses: GitHub's records are the only pick record, and a
pick GitHub refuses to enqueue fails `quest merge`, which says to fix the PR
with `/quest-iterate` and land it again. The plans this quest held for
refused picks are dropped with it: merging the base locally with the quest
driver (the host gate's local mergeability, from
[moq-dev/moq#7407](https://github.com/moq-dev/moq/pull/7407) and
[moq-dev/moq#7382](https://github.com/moq-dev/moq/pull/7382)), and parking a
PR whose own required checks fail for the fixer
([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)'s
decision 8).

- Find the candidates in the pass
  [Queue removals](/quest/m0/queue-watcher/removals.md) runs: open PRs with an
  `autoMergeRequest`, no `mergeQueueEntry`, and a ready `mergeStateStatus`
  (`CLEAN`, `HAS_HOOKS`, or `UNSTABLE`).
- Enqueue with `enqueuePullRequest` and `expectedHeadOid` set to the head
  `enabledHead` (`src/cli/status.ts`) says auto-merge was armed on, only when
  that is the current head. GitHub keeps auto-merge across a writer's push,
  but that push ends the pick; a head `enabledHead` can't tell yet waits for
  the next pass. An "already queued" refusal means GitHub moved it first.
- An armed pick whose own required checks fail, or that turns conflicting,
  is left alone: it needs `/quest-iterate` and a new pick, and
  `quest status` shows its checks.

## Required

- [Queue removals](/quest/m0/queue-watcher/removals.md) - the pass that reads each PR's auto-merge and queue state
