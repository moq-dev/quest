# [M] kix.quest shows each repository's landing queue

## Goal

quest.moq.dev shows each enrolled repository's landing queue, whether GitHub's
merge queue or the watcher's [own queue](/quest/m0/queue-watcher/own-queue.md)
runs it:

- the queued PRs in landing order;
- the build in progress, with a link to its run;
- recent drops, with each one's reason and the fixer's outcome or handback.

A private repository's queue is visible only to viewers who can read the
repository, as with the rest of kix.quest.

Non-goals: a status API the watchers push to.

## Plan

Decided 2026-11-06 (maintainer, /quest-plan):

- Scope:
  - ✅ Every repository, in both modes, so landing has one place to look
  - Own-queue repositories only
- Data:
  - ✅ kix reads GitHub with the viewer's token, as it already reads a PR's
    auto-merge and merge-queue state (`cloudflare/src/github/service.ts`).
    It needs no new credential and adds no private-repository data to kix.
    The maintainer expects a status API the watchers push to later, for
    detail GitHub lacks, such as a fixer job's live progress.
  - Each watcher reports its state to kix with a per-host token

Sources, per mode:

- Order: `mergeQueueEntry.position` in GitHub's queue, and armed auto-merge
  `enabledAt` in the own queue.
- Current build: the `merge_group` workflow run, or the own queue's per-PR
  check run and the queue-branch run it links.
- Drops and fixer results: `RemovedFromMergeQueueEvent` and the watcher's
  comments, which name the reason and the fixer's outcome.

## Required

- [The watcher runs its own serial queue](/quest/m0/queue-watcher/own-queue.md) - the own queue's per-PR check run the page reads

## Related

- [Private repositories](/quest/m0/kix/private.md) - how kix.quest gates a private repository's pages to its readers
