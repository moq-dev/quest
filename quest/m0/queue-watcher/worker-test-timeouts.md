# [M] Worker route tests fit their timeout

## Goal

The Worker's route tests pass in `merge_group` runs without timing out, so
the merge queue stops ejecting PRs for them. Each test fits comfortably under
its limit for a measured reason, rather than through a blanket timeout raise.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#481](https://github.com/moq-dev/quest/pull/481)). That day,
5 of 6 failed merge-queue runs were Worker route tests exceeding vitest's 5s
default: `cloudflare/test/projects.test.ts` ("enrolled project observations",
three times) and `cloudflare/test/github.test.ts` ("signed GitHub webhooks",
twice), on PRs that didn't touch the Worker
([run 41901538568](https://github.com/moq-dev/quest/actions/runs/41901538568)
is one). The land fixer re-queued each as flaky, costing a queue slot each
time, and #481 hit its three-flaky stop rule.

- What should the quest's goal be?
  - ✅ Fix the root cause: find what makes these tests slow in merge-group
    runs and make each fit, raising a timeout only where a measured cost
    justifies it
  - Rejected: raising the suite's timeout; leaving it to the watcher's flaky
    handling
- Which milestone?
  - ✅ m0, in this epic, since it stalls the merge queue today
  - Rejected: m1

Implementation guidance:

- Measure first: per-test durations on the queue runners against a local
  run, and where the time goes (Miniflare and D1 setup per test, the auth
  flows, signing, host load). `cloudflare/vitest.config.ts` already moved
  Miniflare's D1 to `/dev/shm` for a similar stall.
- Check whether the queue runners share a loaded host
  ([Harden the queue runners](/quest/m0/queue-watcher/runners.md) owns
  their setup) before blaming the tests.
- Verify with repeated runs under the queue runner's conditions, not one
  green run.
