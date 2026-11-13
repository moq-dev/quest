# [S] Make the usage and review tests host-independent

## Goal

`just test` passes on any host, independent of its filesystem and environment, with each test isolating what it reads rather than skipping it.

## Plan

Two tests pass in CI but failed on the land fixer's host, on main alone (2026-11-13):

- `test/usage.test.ts`, "ties each session to its PR and role": its fixture sessions use `cwd: "/work"` and treat it as a deleted checkout, so a host with a real `/work` attributes sessions differently. [#704](https://github.com/moq-dev/quest/pull/704) rewrites this file but its `exported` fixture still uses `/work`. Root it in a temporary directory the test controls (one created, one removed), whichever PR lands second.
- `test/review.test.ts`, "Codex reaches a gateway at OPENAI_BASE_URL": the direct run expected exit 1 and got 3, which suggests ambient provider variables (`OPENAI_BASE_URL` and the like) from the host reach the fake Codex. Confirm the cause, then have the review test setup clear every variable the gateway detection reads.
