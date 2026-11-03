# [S] quest review reports a reviewer's usage limit

## Goal

When the reviewer CLI fails because its account hit a usage limit or quota,
`quest review` exits with a distinct status and prints the reset time, so an
agent records the outage as a `## Waiting` item without parsing the
reviewer's error text.

## Plan

Decided 2026-11-02 (user, /quest-spawn follow-ups): ✅ plan as stated
(rejected: drop it); ✅ m0 (rejected: m1, m2).

- Raised by [moq-dev/quest#411](https://github.com/moq-dev/quest/pull/411),
  whose guide rule turns a reviewer's quota or login failure into a
  `## Waiting` item naming when it resets. About 29 sessions between
  2026-10-30 and 11-01 ended on a reviewer's weekly quota.
- Reuse the matchers that exist: Claude Code's usage-limit `LIMIT` in
  `src/runner/claude.ts` and `quest agent`'s `EXHAUSTED` in
  `src/cli/agent.ts`. Move them where both and `quest review` import them,
  rather than adding a third copy.
- Document the exit status in `quest review --help` and the README, and
  point #411's rule at it.
