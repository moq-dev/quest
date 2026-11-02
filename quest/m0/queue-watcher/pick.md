# [S] quest merge --land enqueues into GitHub's merge queue

## Goal

On a base with a merge queue, `quest merge <pr> <token> --land <sha>`
enqueues the pinned head into GitHub's merge queue, or arms auto-merge bound
to it while its required checks are pending, and records the pick so the
watcher knows which head the maintainer picked. It never refuses a head for
being behind the base, since the queue builds each PR on the current base. A
pick GitHub refuses to enqueue (conflicts, failing required checks, or another
mergeability refusal) is still recorded, and the command says the watcher will
fix it rather than failing.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)): picks enqueue into GitHub's merge
queue, and the watcher fixes a pick GitHub refuses.

`land` in `src/cli/hold.ts` already enables auto-merge bound to the head on a
queue base (`snapshot.queue`), which enters the queue once checks pass. What
changes:

- Skip the behind-or-diverged comparison on a queue base. It exists for
  ungated bases, where nothing else tests the PR on the current base.
- Prefer `enqueuePullRequest` with `expectedHeadOid` when the PR is already
  mergeable, so the head is pinned and enqueued at once. GitHub enqueues a PR
  only once its required checks pass on the PR itself.
- Record the pick durably. On the host gate the pin lives in squash
  auto-merge's commit body, which a conflicting PR cannot get, and GitHub drops
  auto-merge when the queue removes a PR. Pick a marker the watcher can read
  for a refused or removed PR, such as a comment naming the picked head, and
  coordinate with [moq-dev/quest#326](https://github.com/moq-dev/quest/pull/326),
  which drops the `quest:merge` label. The pick covers that head and the heads
  the fixer pushes from it.
- `quest:merge` (or its successor) must not be released when the queue drops
  the PR while the watcher still holds it (`dequeued` in `src/cli/hold.ts`);
  only a handback ends the pick.
- Bases that require the `quest land` check keep queuing for the host gate
  until their repository [follows](/quest/m0/queue-watcher/follow.md).

## Related

- [Bad picks](/quest/m0/queue-watcher/bad-picks.md) - what the watcher does with a refused pick
