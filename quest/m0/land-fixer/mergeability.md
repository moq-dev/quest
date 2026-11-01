# [S] quest land merges locally instead of trusting GitHub's mergeability

## Goal

`quest land` never ejects a PR as `merge_conflict` because of GitHub's
mergeability alone. When the squash API refuses a PR that GitHub marks as
conflicting, the gate merges the base into it locally with the quest merge
driver, pushes that merge, and lands the PR. When the local merge also
conflicts, the PR stays queued and parked while the fixer resolves it; it
leaves the queue only on a handback (2026-11-01, see the
[epic](/quest/m0/land-fixer/README.md)).

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run). GitHub reported conflicts on
[moq-dev/moq#7407](https://github.com/moq-dev/moq/pull/7407), which merges
cleanly, and on [moq-dev/moq#7382](https://github.com/moq-dev/moq/pull/7382),
whose only conflict was in quest link lists, which the driver resolves.

`mergePinned` (`src/cli/land-serve.ts`) returns `merge_conflict` when
`pull.mergeable === false` or `mergeable_state === "dirty"`. Hand that case
to `prepareHead` (`src/cli/land-head.ts`), which already merges with the
driver through `mergeBase` (`src/cli/land.ts`), instead of ejecting.

Since batch triage ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)), that
`merge_conflict` already parks the PR for the fixer (`fail` in
`src/cli/land-serve.ts`) instead of ejecting it, and the rest of the batch
stays queued; this quest adds the local merge before parking.
