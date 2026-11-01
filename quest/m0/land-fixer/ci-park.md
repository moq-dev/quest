# [S] A PR whose own CI fails is parked for the fixer

## Goal

A queued PR whose required GitHub checks fail is not ejected. The gate
fetches the failing checks' logs, parks the PR, and starts a fixer job with
those logs, the same way it handles a failing batch. The PR leaves the queue
only if the fixer hands it back.

## Plan

Decided 2026-11-01 (user, settling
[moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)'s decision 8,
[record](https://github.com/moq-dev/quest/pull/355#issuecomment-6561562421)):

- A PR whose own required GitHub CI fails:
  - ✅ Park it with the failing check's log for the fixer
  - Keep ejecting it at once

It builds on the parking mechanism from batch triage ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355))
(`src/cli/land-park.ts`, and `fail(...)` in `src/cli/land-serve.ts`). Fetch
each failing check run's log through the App's `checks: read` and
`actions: read`, and trim it the way the batch failure excerpt is trimmed. A
fix the fixer pushes reruns the PR's CI. The PR rejoins batches once its
required checks pass, as with
triage's `checks_pending` rule.

## Related

- [Queue status in the required check](/quest/m0/land-fixer/check-status.md) - shows the PR's parked state
