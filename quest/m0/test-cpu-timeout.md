# [M] Tests time out on CPU time, not wall time

## Goal

A unit test fails for taking too long only when it spends too much CPU, so a
loaded host never fails a test that is merely waiting its turn, while a hung
test still fails. The merge-group build stops dropping PRs for tests that
passed vitest's 5 s wall-clock default under load.

## Plan

Evidence (2026-11-10, /quest-complete): 5 of the last 8 failed
`merge_group` builds on this repository failed only on `Test timed out in
5000ms` (or 20 s / 30 s per-test overrides) on the self-hosted runner, which
shares the desktop with about a dozen agents:

- `test/review.test.ts`: four different tests across runs
  [42849648498](https://github.com/moq-dev/quest/actions/runs/42849648498)
  ([moq-dev/quest#602](https://github.com/moq-dev/quest/pull/602)),
  [42854330578](https://github.com/moq-dev/quest/actions/runs/42854330578)
  ([moq-dev/quest#595](https://github.com/moq-dev/quest/pull/595)) and
  [42871151560](https://github.com/moq-dev/quest/actions/runs/42871151560)
  ([moq-dev/quest#598](https://github.com/moq-dev/quest/pull/598)).
- `test/init.test.ts` (CRLF setup), `test/agent.test.ts` and
  `test/land.test.ts`: runs
  [42679505693](https://github.com/moq-dev/quest/actions/runs/42679505693)
  and [42716547792](https://github.com/moq-dev/quest/actions/runs/42716547792).

Each passed on re-queue. They are not flaky in their logic: a wall-clock
limit measures the host's load, and these tests assert nothing about speed.
No single PR caused this; the default timeout is as old as the suite.

Decided 2026-11-10 (user, /quest-plan follow-up from /quest-complete):

- Approach: ✅ a CPU-time watchdog. Each test gets a budget of CPU spent by
  its worker and the processes it spawns (on Linux, from a cgroup's
  `cpu.stat`), plus a wall-clock bound for hangs, since a hung test waiting
  on a child or on IO spends no CPU and only wall time catches it (rejected:
  a generous wall `testTimeout` as a hang bound only; keep 5 s and reduce the
  queue build's load).
- Milestone: ✅ m0, since these drops slow every merge here (rejected: m1).

Open for the implementer, with recommendations:

- Platforms without the cgroup measurement (macOS, Windows, Linux without a
  systemd user manager) decide at setup and use the wall hang bound alone,
  per `quest context`'s rule against runtime fallback.
- Size the wall hang bound so a loaded host never reaches it on a test that
  makes progress (minutes, not seconds), and the CPU budget from measured
  per-test CPU, with headroom.
- Prefer reusing the gate's scope and `cpu.stat` sampling
  ([gate measured CPU](https://github.com/moq-dev/quest/pull/607) is in
  flight) over a second implementation.
- Remove the per-test wall overrides that only existed to survive load.
