# [S] The native Windows suite passes nightly

## Goal

Check's `native Windows` jobs run nightly against `main` and on
`workflow_dispatch`, not on pull requests or in the merge group, and they
pass on both `windows-2022` and `windows-11-arm`. A Windows regression may
land; the next nightly run catches it, and GitHub's notification for a
failed scheduled run is the signal.

## Plan

Decided 2026-11-03 (coordinator, /quest-complete follow-ups, under the
user's 2026-11-02 instruction to decide follow-ups from evidence): plan it.
The user chose to land [moq-dev/quest#437](https://github.com/moq-dev/quest/pull/437)
and fix these failures separately.

Decided 2026-11-03 (user, /quest-complete, on
[moq-dev/quest#455](https://github.com/moq-dev/quest/pull/455)), moving it
from m0 to m1 since Windows isn't a priority:

- How should a Windows regression be caught before it lands?
  - Run on ready PRs (recommended), not picked
  - Require in the merge group, not picked
  - Main only, cancelling in progress only on PRs, not picked
  - ✅ Other: "I don't really care about windows, it's fine if we catch
    issues nightly."

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
- Today the Windows jobs run on every push to `main` and on dispatch
  (`if: github.event_name != 'pull_request'` in
  `.github/workflows/check.yml`). Check's `cancel-in-progress` cancels most
  of those pushes in a busy hour, so a failure surfaces only on the last
  push of a burst. The queue build (`.github/workflows/queue-build.yml`)
  runs on Linux only.
- Install check's Windows jobs failing against v0.1.0 is a different cause:
  v0.1.0 has no Windows assets. The next release covers it
  ([Release with worktree hooks](/quest/m1/release.md)).

Work:

- Fix the 7 failures where each one's cause lies, so the first nightly run
  starts green: compare text with line endings normalized wherever Git or
  Quest may write CRLF on Windows, use `path.delimiter` in the `PATH`
  expectation, and await `main` for `worktree create`. Keep each test's
  assertion; never skip a test on Windows to pass.
- Run the Windows jobs on a nightly `schedule` against `main` and on
  `workflow_dispatch`. Prefer nightly only, dropping them from pushes to
  `main`, as the simpler and cheaper choice; keep push runs only if the
  work finds a concrete reason. Whether they stay in `check.yml` or move to
  a workflow of their own is this quest's call, whichever keeps the
  triggers simplest.
- Rely on GitHub's failure notification for scheduled runs, which goes to
  whoever last changed the workflow's cron. Add no issue filing, chat
  alert, or other reporting.
- Dispatch the Windows jobs on the PR's head and record that both pass.
