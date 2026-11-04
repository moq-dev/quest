# [S] Only genuine flakes count toward disabling a test

## Goal

`quest land watch` records a flaky verdict only for a failure that comes and
goes with no cause in the PR, the base, or the runner. A failure that
reproduces on the base or comes from the runner's environment is requeued
without counting toward a disable. Two such failures can never auto-disable
a real test.

## Plan

Decided 2026-11-03 (coordinator, /quest-complete follow-ups, under the
user's 2026-11-02 instruction to decide follow-ups from evidence): plan it,
[S], in this epic. The 2026-11-02 follow-up review sent this to
[moq-dev/quest#406](https://github.com/moq-dev/quest/pull/406) as
[a comment](https://github.com/moq-dev/quest/pull/406#issuecomment-6596308277).
#406 merged without it.

Evidence, gathered 2026-11-03 on `main`:

- `src/cli/land-watch-fix.ts:516-523` labels every unchanged requeue of a
  failed build `flaky`, and `recordFlaky` (`src/cli/land-watch-flaky.ts`)
  counts each one toward the two verdicts that take a `disable`. Its PR is
  enqueued with no person's pick.
- `assets/land-fix.md`'s `## Flaky tests` defines flaky as "no cause in the
  PR or the base". It gives no action for a failure that reproduces on the
  base or comes from the runner, so the fixer can only requeue those
  unchanged or hand them back. A requeue then counts as a flaky verdict.
- Earlier rounds that were requeued as flaky but weren't:
  [moq-dev/quest#324](https://github.com/moq-dev/quest/pull/324#issuecomment-6593076398)
  (EROFS on `cgroup.kill`, a runner gap fixed in kixelated/nixos#19),
  [#324 again](https://github.com/moq-dev/quest/pull/324#issuecomment-6593268009)
  (missing `flock`/`script`, where the fixer itself wrote "environment
  dependency issue, not a flaky test"), and
  [moq-dev/moq#7560](https://github.com/moq-dev/moq/pull/7560#issuecomment-6572579456)
  and [moq-dev/moq#7221](https://github.com/moq-dev/moq/pull/7221), where
  an unused import already on `main` was requeued twice under signatures
  that differed only by backticks.
- No disable PR has opened on moq-dev/moq yet: it has no `quest/m0/flaky/`
  and no `quest-land/flaky-*` PR. Nothing needs undoing.

Work:

- Let a requeue name its cause: flaky, the base, or the environment. The
  watcher records only flaky ones in `flaky.json`. The other causes still
  requeue at the back and still count as rounds for the stop rules.
- Tell the fixer in `assets/land-fix.md`: a failure that reproduces on
  `base`, or one that comes from the runner (a missing tool, a read-only
  path, a full disk), is not flaky. Name its cause, never `disable`.
- Normalize a `failure` signature before matching it (strip backticks and
  quotes, collapse whitespace), so one test's verdicts aren't split.
- Tests: a base failure requeued twice takes no disable, and two flaky
  verdicts whose signatures differ only in quoting do.
