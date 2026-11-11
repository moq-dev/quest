# [S] Claude's sandbox control runs its apiKeyHelper plant

## Goal

`just review-sandbox` passes for Claude Code again: its control run fires
every plant the test keeps, so each "fires nothing under `quest review`"
check for Claude proves something. No plant stays that Claude Code never
runs in a configuration a reviewer could see.

## Plan

Found by [moq-dev/quest#603](https://github.com/moq-dev/quest/pull/603)'s
validation: with Claude Code 2.1.x in print mode and a stored login, the
control no longer sees the planted `apiKeyHelper`
(`test/live/review-sandbox.test.ts`, the `.claude/settings.json` plant) fire,
so the control fails. It fails the same way whether or not the control sets
`PWD`, and opencode and Codex pass. No single PR caused it: a Claude Code
release changed when the helper runs.

Decided 2026-11-10 (user, /quest-plan of #603's follow-up from
/quest-complete):

- Approach: ✅ find the release behavior first. If Claude Code still runs
  `apiKeyHelper` in some configuration a reviewer could hit, such as no
  stored login, run the control in that configuration so the plant fires.
  Drop the plant only if no such configuration exists (rejected: drop the
  plant outright; keep it and accept a failing control).
- Milestone: ✅ m1, beside [model check](/quest/m1/model-check.md), which runs
  `just review-sandbox` each milestone (rejected: m0, m2).

Running the control needs working Claude credentials: under a host-managed
`ANTHROPIC_BASE_URL`, copied logins cannot authenticate, so unset it as
#603 did.

## Related

- [Model check](/quest/m1/model-check.md) - runs the live sandbox test each milestone and plans a quest per failure
