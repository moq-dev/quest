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
- The contract: `quest review` exits 3, which it uses for nothing else
  (0 is a round, 1 a failure, 2 a usage error), and prints one stderr line,
  `error: <harness> hit its usage limit; resets <time>`, where `<time>` is
  the reset as an ISO 8601 UTC timestamp, or `unknown` when the CLI's
  output names none. Claude Code reports the reset as `resetsAt` epoch
  seconds (`src/runner/claude.ts`); take Codex's from its error if it gives
  one.
- Document the contract in `quest review --help` and the README, and point
  #411's rule at it, so all three say the same.
