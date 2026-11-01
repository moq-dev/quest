# [S] GitHub requests retry transient failures

## Goal

One 5xx response or dropped connection no longer fails a quest command or a
land step. `GitHub.request` (`src/cli/github.ts`) retries 5xx, 429 and
network errors with bounded backoff, then fails with the last error.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from moq.pro's and rust2's cutover to the host gate and the fixer repairs [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320), [#325](https://github.com/moq-dev/quest/pull/325), [#327](https://github.com/moq-dev/quest/pull/327) and [#328](https://github.com/moq-dev/quest/pull/328)).

- A 502 while the fixer handed back
  [moq-dev/moq#7323](https://github.com/moq-dev/moq/pull/7323) replaced the
  crash reason; [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320)
  kept the original error but left the retry for this quest.
- Retry only idempotent reads and writes whose repeat is safe (GET, PUT,
  DELETE, label and auto-merge mutations that check state first). A POST that
  creates a comment or a merge must not run twice; check the effect before
  repeating it.
- Honour `Retry-After` and the secondary rate limit.
