# [XS] Drop review-rounds from quest status

## Goal

`quest status` no longer prints `review-rounds` or its JSON
`reviewRounds`. It counts GitHub reviews since a `Design change:` comment,
but the guide now counts design-checkpoint rounds by `quest review` session,
which prints each round's number itself.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)).

- Remove the field from `src/cli/status.ts`, `--help`, the README's status
  table and example, and the tests. The JSON field's removal is breaking, so
  mark the commit `!`.
- Counting local rounds from the PR body's `## Review` record was rejected:
  `quest status` does not parse PR body conventions (the helpers epic's
  2026-10-19 decision), and `quest review` already knows its round.
