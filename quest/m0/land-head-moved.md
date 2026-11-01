# [S] quest land reports head_moved only when a writer moved the head

## Goal

`quest land` ejects a PR as `head_moved` only when someone other than the
gate pushed to it after it was queued. The gate's own base-merge push is
never counted as a moved head. A PR stopped because a batch-mate conflicted
or moved is ejected with that reason, naming the batch-mate.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run). PRs were wrongly ejected as `head_moved`:
[moq-dev/moq#7407](https://github.com/moq-dev/moq/pull/7407),
[moq-dev/moq#7416](https://github.com/moq-dev/moq/pull/7416),
[moq-dev/moq#7353](https://github.com/moq-dev/moq/pull/7353),
[moq-dev/moq#7413](https://github.com/moq-dev/moq/pull/7413).

- Own push. `prepareHead` (`src/cli/land-head.ts`) pushes a base merge to a
  PR's head, and `isPrepared` recognises that head from a private record. Land
  still reported `head_moved` after that push, so one of the checks in
  `resolveQueue` (`src/cli/land.ts`), `prepareHead`, or `mergePinned`
  (`src/cli/land-serve.ts`) missed it.
  Find the case the record misses, such as GitHub lagging, a restart, or
  `forgetHeads` running too early, and cover it with a test.
- Batch-mates. When one link fails to merge, `serveBatch`
  (`src/cli/land-serve.ts`) ejects every remaining link with that link's
  reason and detail. Give the other PRs their own reason, one that names
  the PR that stopped the batch.
