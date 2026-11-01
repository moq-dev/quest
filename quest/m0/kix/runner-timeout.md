# [XS] The kix runner's conflicted-continuation test is fast under load

## Goal

`test/runner.test.ts` "pauses a large conflicted continuation with a bounded
question and intact checkout" passes on a loaded host well inside vitest's
5-second limit, without raising the limit.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from moq.pro's and rust2's cutover to the host gate and the fixer repairs [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320), [#325](https://github.com/moq-dev/quest/pull/325), [#327](https://github.com/moq-dev/quest/pull/327) and [#328](https://github.com/moq-dev/quest/pull/328)).

- It hit the 5-second timeout in quest's own land gate on 2026-10-31 and
  ejected [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320),
  which does not touch the runner.
- Find which step is slow (a large fixture write, git calls, or a wait) and
  remove the cost; never retry the test or tune the timeout until it passes.
