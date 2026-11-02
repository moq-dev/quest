# [M] A flaky failure is re-enqueued, and a twice-flaky test is disabled

## Goal

When the fixer judges a dropped PR's failure flaky, the watcher re-enqueues
the PR unchanged. The watcher keeps a per-repository record of flaky
verdicts by test. A test seen flaking twice is disabled in a separate PR that
also adds a follow-up quest to fix or delete it in the repository's m0
`flaky` epic; the watcher enqueues that PR like any other, with no human pick
needed.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)):

- Flaky failures:
  - ✅ The fixer re-enqueues them unchanged, and a test seen flaking twice is
    disabled in a separate PR with a follow-up quest. The host gate's rerun
    before blame ([moq-dev/quest#375](https://github.com/moq-dev/quest/pull/375),
    and moq's module naming for it,
    [moq-dev/moq#7588](https://github.com/moq-dev/moq/pull/7588)) is dropped;
    both PRs are closed.

Carried over from the host gate's flaky-test quest, whose decisions still
apply (2026-11-01, user and maintainer):

- A flaky ffmpeg render timeout in moq's interop tests ejected whole batches
  on 2026-11-01, and its fix
  ([moq-dev/moq#7480](https://github.com/moq-dev/moq/pull/7480)) was written
  by hand. The user asked for "a rule to immediately disable any flakey tests
  and create a follow-up to fix/delete them".
- The disable goes in its own PR, never inside another PR's commit, since PRs
  land as squashes and an unrelated PR's commit would carry it.
- The follow-up goes in a standing `flaky` epic in the repository's m0, one
  quest per disabled test.

What counts: the second flaky verdict for the same test, across any PRs, in
the watcher's state. A single verdict only re-enqueues, since disabling on one
judgment alone risks hiding a real bug. Each verdict names the test in the
same signature the stop rules use (the fixer result's `failure`), and the
third flaky round of one PR in a row hands it back there (`stopRule` in
`src/cli/land-fixer.ts`).

The fixer container holds no GitHub credentials, so the fixer returns the
disabling commit in its result and the watcher pushes it to a new branch and
opens the PR as moq-bot, the way the host gate opened its
`quest-land/fix-<sha>` base fixes. The fixer writes the skip in the test framework's own form, with the reason
naming the follow-up quest: `#[ignore = "flaky: /quest/m0/flaky/<name>.md"]`,
`test.skip`, `pytest.mark.skip`, and so on. The follow-up quest's Goal says to
fix the test or delete it, and links the `merge_group` runs that showed the
flake. A disabled test that is a quest's acceptance test still counts as its
quest's work.

## Required

- [Fix and re-enqueue](/quest/m0/queue-watcher/fix.md) - the fixer's flaky verdict and the re-enqueue
