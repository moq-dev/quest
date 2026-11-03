# [S] The test suite passes on native Windows again

## Goal

Check's `native Windows` jobs pass on `main` on both `windows-2022` and
`windows-11-arm`, and a PR that breaks them is caught before it lands, in
whatever way the maintainer picks below.

## Plan

Decided 2026-11-03 (coordinator, /quest-complete follow-ups, under the
user's 2026-11-02 instruction to decide follow-ups from evidence): plan it,
[S], m0, since the standalone CLI serves native Windows in m0. The user
chose to land [moq-dev/quest#437](https://github.com/moq-dev/quest/pull/437)
and fix these failures separately.

Evidence, gathered 2026-11-03:

- `main`'s Check has failed on every completed push since `ef8c4b50`
  (15:45Z), only in its native Windows jobs. The latest,
  [run 41696344037](https://github.com/moq-dev/quest/actions/runs/41696344037)
  on `ee96a82e`, has 7 failures:
  - `test/runner.test.ts` › "pick the other vendor…": the test expects a
    `:`-joined `PATH`, while `reviewerFor` correctly joins with
    `path.delimiter` (`src/runner/review.ts:51`). From
    [moq-dev/quest#417](https://github.com/moq-dev/quest/pull/417).
  - `test/move.test.ts` › three `quest check --fix` tests expect LF where
    Windows writes CRLF. From
    [moq-dev/quest#427](https://github.com/moq-dev/quest/pull/427).
  - `test/worktree.test.ts` › "initializes nested submodules…" and "ignores
    inherited Git location variables…" expect `original\n` and read
    `original\r\n`. "fails explicitly without a supported backend" calls
    the synchronous `run` helper for `worktree create`, which is now async
    ("use await main for asynchronous CLI commands"). The test skips on
    Linux, and only Windows runs the suite elsewhere. All three first fail
    on `ee96a82e`, after
    [moq-dev/quest#445](https://github.com/moq-dev/quest/pull/445) and
    [#437](https://github.com/moq-dev/quest/pull/437).
- Nothing runs native Windows before a PR lands. Since
  [moq-dev/quest#397](https://github.com/moq-dev/quest/pull/397) moved
  quest to the merge queue, Check's jobs skip pull requests
  (`if: github.event_name != 'pull_request'`). The queue build
  (`.github/workflows/queue-build.yml`) runs `just check` and `just test` on
  the Linux host only. Check's `cancel-in-progress` also cancels most pushes
  to `main` in a busy hour, so a failure surfaces only on the last push of a
  burst.
- Install check's Windows jobs failing against v0.1.0 is a different cause:
  v0.1.0 has no Windows assets. The next release covers it
  ([Release with worktree hooks](/quest/m1/release.md)).

Work:

- Fix the 7 failures where each one's cause lies: compare text with line
  endings normalized wherever Git or Quest may write CRLF on Windows, use
  `path.delimiter` in the `PATH` expectation, and await `main` for
  `worktree create`. Keep each test's assertion; never skip a test on
  Windows to pass.
- Dispatch Check on the PR's head and record that both Windows jobs pass.
- Then make the change the maintainer picks below.

## Waiting

- Maintainer: how should a Windows regression be caught before it lands?
  Options: (1, recommended) run Check's two `native Windows` jobs on ready
  PRs again, outside the merge queue. They add no queue time, and
  `/quest-merge` and the land fixer already read a PR's own CI
  ([moq-dev/quest#408](https://github.com/moq-dev/quest/pull/408)).
  (2) Add them to the merge group as required checks, so nothing red lands,
  at up to 6 minutes per landing in a one-at-a-time queue (the arm job took
  6 on `ee96a82e`), less whatever the Linux build overlaps.
  (3) Keep them on `main` only, and cancel in progress only on PRs, so every
  push to `main` reports. Check by a ✅ recorded in this quest's Plan.
