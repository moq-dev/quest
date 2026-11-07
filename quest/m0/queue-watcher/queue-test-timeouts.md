# [L] Tests fit their timeout on the queue runner

## Goal

The root and Worker test suites pass in `merge_group` runs on the queue
runner without timing out or stalling, so the merge queue stops ejecting PRs
for tests they don't touch. Each test fits comfortably under its limit for a
measured reason, rather than through a blanket timeout raise.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#481](https://github.com/moq-dev/quest/pull/481)), on the Worker
route tests alone. Widened to the root suite the same day, when this quest's
own PR, [moq-dev/quest#497](https://github.com/moq-dev/quest/pull/497), was
ejected for two root-suite tests although it changes only Markdown.

That day, 10 of 11 failed merge-queue runs failed in tests:

- Worker, 7 runs: `cloudflare/test/projects.test.ts` ("enrolled project
  observations", four times) and `cloudflare/test/github.test.ts` ("signed
  GitHub webhooks", three times) exceeded vitest's 5s default, six of them on
  PRs that didn't touch the Worker
  ([run 41901538568](https://github.com/moq-dev/quest/actions/runs/41901538568)
  is one).
- Root, 3 runs: `test/review.test.ts` timed out twice, "a missing or
  logged-out reviewer CLI is a usage error" at 5.2s
  ([run 41905766925](https://github.com/moq-dev/quest/actions/runs/41905766925))
  and "a reviewer's usage limit exits 3 with its reset, and records no round"
  at 5.9s; `test/land.test.ts` "host daemon > opens the halt issue when the
  base fixer's launch was lost" ran 1221s against its 30s limit, both in
  [run 41924229558](https://github.com/moq-dev/quest/actions/runs/41924229558);
  and `test/gate.test.ts` "killing stops a command that ignores the request"
  failed an assertion
  ([run 41888531939](https://github.com/moq-dev/quest/actions/runs/41888531939)).

The land fixer re-queued each as flaky or handed it back, costing a queue
slot each time; #481 hit its three-flaky stop rule.

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

- It looks environmental, and specific to the queue runner. The queue build
  runs on `nixos-quest-ci`, which
  a kixelated/nixos change added to
  the maintainer's host
  ([the cutover](/quest/m0/queue-watcher/follow.md));
  [Harden the queue runners](/quest/m0/queue-watcher/runners.md) only
  restricts its access. Every `check` job of the `Check` workflow on main
  that finished that day, 27 by 23:00 UTC, passed both suites on
  GitHub-hosted Ubuntu. On base `ba352ea8`, the
  root suite took 122s there
  ([run 41924220424](https://github.com/moq-dev/quest/actions/runs/41924220424))
  while the queue runner took 1590s on it at the same time (run 41924229558),
  and 125s and 372s in the next queue runs on the same base
  ([run 41923472254](https://github.com/moq-dev/quest/actions/runs/41923472254),
  [run 41928750874](https://github.com/moq-dev/quest/actions/runs/41928750874)).
  In the slow run, `land.test.ts` tests that took 0.5-2.6s in the other two
  took 12-23s. Measure the host's load and memory pressure during queue builds,
  and what else runs there, before blaming the tests.
- Some tests have little headroom even on an idle host.
  "a reviewer's usage limit exits 3 with its reset, and records no round",
  added by [moq-dev/quest#471](https://github.com/moq-dev/quest/pull/471),
  runs four cases in one test, each with its own repository and two `quest`
  CLI runs: 3.3s of its 5s on a developer machine.
  [moq-dev/quest#470](https://github.com/moq-dev/quest/pull/470) had just
  split this file's tests to one `quest review` per variant for that reason.
  Find such tests by their share of the limit on a
  quiet host, not by which one timed out last.
- The `land.test.ts` run is a stall, not slowness: the test takes 0.4s alone,
  and its 30s timeout fired only at 1221s, so its vitest worker ran no timers
  for about 20 minutes. Either a synchronous call blocked it, such as the
  `spawnSync` in `git()` (`src/cli/git.ts`), or the host didn't schedule it.
- The Worker timeouts look like one test stalling, not a slow suite: in
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
  `just worker-test-isolated` runs each Worker case alone.
- Verify with repeated runs under the queue runner's conditions, not one
  green run.
