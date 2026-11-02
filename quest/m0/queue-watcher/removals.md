# [M] The watcher sees each PR the merge queue drops, and why

## Goal

A long-running watcher on the host notices every PR that leaves a
repository's merge queue unmerged, within a minute or two, and records why:
a failing `merge_group` build (with the failing jobs' logs), a conflict, a
push to the PR, or a person removing it. It posts a comment on the PR naming
the reason and the failing log's tail. The watcher survives restarts without
missing or repeating a removal.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)).

- Poll, don't receive webhooks: the host has no public endpoint. Reconcile
  from GitHub's records of each pick, not from queue snapshots alone: a PR
  enqueued and dropped between two polls, or while the watcher was down,
  never shows in a snapshot. Each pass reads the base's open PRs, many per
  GraphQL query, with their `mergeQueueEntry`, their
  `autoMergeRequest { enabledBy enabledAt }`, and their
  `AddedToMergeQueueEvent`s and `RemovedFromMergeQueueEvent`s newer than the
  last one handled (`timelineItems(since:)`): `enqueuer`, `actor`, `reason`,
  and the removal's `beforeCommit`. `quest status` already reads the removal
  event (`src/cli/status.ts`). The base's `mergeQueue { entries }` can still
  serve as a cheap change signal. The App's installation token has its own
  rate limit, separate from the maintainers' sessions.
- A pick is GitHub's own record, with no marker of quest's
  (decided 2026-11-02; see the [epic](/quest/m0/queue-watcher/README.md)):
  the PR was enqueued, or had auto-merge armed while its required checks were
  pending, as `quest merge --land` does on a merge-queue base. GitHub lets
  only a writer enqueue a PR or enable auto-merge, so the `enqueuer` or
  `enabledBy` is the trust signal; nothing reads comments or checks a
  commenter's permission. The removal's `beforeCommit` is the head the queue
  dropped. A pick covers that head and the heads the fixer pushes from it,
  which the watcher's App then enqueues itself, and stays active until a
  handback, a push by anyone else, or a person's removal; a writer enqueuing
  the PR again starts a new one.
- For a failed build, find the PR's `merge_group` workflow runs (event
  `merge_group`, head branch `gh-readonly-queue/<base>/pr-<n>-<sha>`) and
  fetch the failing jobs' logs through the App's `actions: read`, trimmed the
  way the host gate trims a batch failure. At build concurrency 1 the group
  holds only this PR, so the failure is its own.
- Classify the reason: a failure or a conflict goes to the fixer
  ([Fix and re-enqueue](/quest/m0/queue-watcher/fix.md)); a person's removal,
  or a push by anyone but the fixer, ends the pick and is left alone.
- Keep each pick's last handled removal event ID in the daemon's state
  directory, as the host gate keeps its queue state, so a restart neither
  misses nor repeats one.
- Start it as `quest land watch` beside `quest land serve`, sharing its App
  credential options, state directory, and comment marker and
  deduplication.
