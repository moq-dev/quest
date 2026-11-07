# [S] quest review continues sessions saved by an older quest

## Goal

A `quest review` round on a branch whose review session was saved by an
older `quest` either continues it, settling the last round's findings, or
refuses before the reviewer runs with an error naming the fix, such as
`--new`. It never spends a reviewer round and then fails.

## Plan

Decided 2026-11-07 (coordinator, follow-up of
[moq-dev/quest#517](https://github.com/moq-dev/quest/pull/517) and
[moq-dev/quest#538](https://github.com/moq-dev/quest/pull/538)): both
iterate agents hit `the reviewer's reply does not settle each of the last
round's undefined finding(s) once` (`src/cli/review.ts`, the `earlier` count),
after the reviewer had already run. #517's session predated
[moq-dev/quest#514](https://github.com/moq-dev/quest/pull/514); #538's
branch was new that day, so reproduce both cases before fixing.

- Find where the last round's finding count comes from and why it is
  `undefined`; `git blame` it to the PR that changed the saved format and
  list it under `## Caused by`.
- Validate the saved session when it is loaded, before the reviewer starts.
  Read the older format when it carries what the round needs; otherwise
  refuse with the error above.
- A test covers a session file in each format the reviewer can meet.
