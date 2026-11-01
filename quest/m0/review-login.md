# [S] Review handles expired logins

## Goal

When a reviewer CLI's login has expired or been revoked, `quest review` fails
with the same "`<harness>` is not logged in; run `<login>`" error it gives a
signed-out CLI, instead of a raw 401 from the reviewer's turn. The error
names the Claude profile it checked.

## Plan

Decided 2026-10-29 (user, /quest-plan of the follow-ups from
[kixelated/rind#31](https://github.com/kixelated/rind/pull/31)), where
`codex login status` exited 0 on a revoked token
(`refresh_token_invalidated`) and every review turn then failed with a 401.

- Map the failure, don't probe: when `turn` in `src/cli/review.ts` fails on
  an authentication error (a 401, or a revoked or expired token), raise the
  `ReviewInputError` the status check raises. This costs no extra request and
  covers Claude Code too.
- Keep the `status` check for the signed-out case.
- Cover it with the fake-CLI tests: one reviewer that exits with each CLI's
  auth error text.

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run): the "not logged in" error names the
`CLAUDE_CONFIG_DIR` profile it checked, or the default when unset. Sessions
running with `~/.claude-personal` were told "claude is not logged in" with no
hint of which profile was read
([moq-dev/moq#7245](https://github.com/moq-dev/moq/pull/7245),
[moq-dev/moq#7210](https://github.com/moq-dev/moq/pull/7210)). The error is
raised in `src/cli/review.ts`'s status check.
On 2026-11-01 (user, /quest-plan), reviewing with credentials from the
environment, added here on 2026-10-30, moved to
[Review through a gateway](/quest/m0/review-gateway.md).
