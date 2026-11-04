# [M] Worker route tests fit their timeout

## Goal

The Worker's route tests pass in `merge_group` runs without timing out, so
the merge queue stops ejecting PRs for them. Each test fits comfortably under
its limit for a measured reason, rather than through a blanket timeout raise.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#481](https://github.com/moq-dev/quest/pull/481)). That day,
7 of 10 failed merge-queue runs were Worker route tests exceeding vitest's 5s
default: `cloudflare/test/projects.test.ts` ("enrolled project observations",
four times) and `cloudflare/test/github.test.ts` ("signed GitHub webhooks",
three times), six of them on PRs that didn't touch the Worker
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

- It looks environmental: the same day, all 22 `check` jobs of the `Check`
  workflow on main ran the whole Worker suite on GitHub-hosted Ubuntu
  without a timeout. The queue build runs on `nixos-quest-ci`, which
  [kixelated/nixos#19](https://github.com/kixelated/nixos/pull/19) added to
  the maintainer's host
  ([the cutover](/quest/m0/queue-watcher/follow.md));
  [Harden the queue runners](/quest/m0/queue-watcher/runners.md) only
  restricts its access. A root-suite test, `test/review.test.ts` "a missing or
  logged-out reviewer CLI is a usage error", also timed out there at 5.2s
  ([run 41905766925](https://github.com/moq-dev/quest/actions/runs/41905766925)),
  so measure the host's load and memory pressure during queue builds before
  blaming the tests.
- It looks like a stall in one test, not a slow suite: in
  [run 41886648526](https://github.com/moq-dev/quest/actions/runs/41886648526)
  no other Worker test took over 807ms. Every timed-out test delivers an
  admitted `pull_request` or `push` webhook, whose route starts `waitUntil`
  background work (`cloudflare/src/github/webhook.ts`), and in
  [run 41879887537](https://github.com/moq-dev/quest/actions/runs/41879887537)
  the next test failed 396ms after the timeout, as if that work outlived its
  test under `isolate: false`. `github.test.ts` stubs no global `fetch`, so its
  background reads may reach the network.
- Earlier rounds: [moq-dev/quest#112](https://github.com/moq-dev/quest/pull/112)
  shared one workerd across files, and
  [moq-dev/quest#130](https://github.com/moq-dev/quest/pull/130) moved
  Miniflare's D1 to `/dev/shm`, both in `cloudflare/vitest.config.ts`.
  [moq-dev/quest#177](https://github.com/moq-dev/quest/pull/177)'s
  `scripts/gate-bench.sh` reproduces suite contention, and
  `just worker-test-isolated` runs each case alone.
- Verify with repeated runs under the queue runner's conditions, not one
  green run.
