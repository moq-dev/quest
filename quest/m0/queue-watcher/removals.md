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

- Poll the queue, don't receive webhooks: the host has no public endpoint.
  One GraphQL query per pass reads the base's `mergeQueue { entries }`, and a
  PR that left since the last pass is looked up: merged, or the newest
  `RemovedFromMergeQueueEvent` on its timeline, with `reason`, `actor`, and
  `enqueuer`. `quest status` already reads that event
  (`src/cli/status.ts`). The App's installation token has its own rate limit,
  separate from the maintainers' sessions.
- For a failed build, find the PR's `merge_group` workflow runs (event
  `merge_group`, head branch `gh-readonly-queue/<base>/pr-<n>-<sha>`) and
  fetch the failing jobs' logs through the App's `actions: read`, trimmed the
  way the host gate trims a batch failure. At build concurrency 1 the group
  holds only this PR, so the failure is its own.
- Classify the reason: a failure or a conflict goes to the fixer
  ([Fix and re-enqueue](/quest/m0/queue-watcher/fix.md)); a person's removal,
  or a push by anyone but the fixer, ends the pick and is left alone.
- Keep the last seen queue and handled removals in the daemon's state
  directory, as the host gate keeps its queue state, so a restart neither
  misses nor repeats one.
- Start it as `quest land watch` beside `quest land serve`, sharing its App
  credential options, state directory, and comment marker and
  deduplication.
