# [S] Gate tests pass deterministically

## Goal

`test/gate.test.ts` passes on every run, loaded host or not, with each
intermittent failure below reproduced and fixed at its cause in the test or
in `quest gate`.

## Plan

Failures seen (2026-11-10, /quest-complete):

- `concurrent processes never admit past the headroom, and admit every
  caller`: `expected [ Array(12) ] to deeply equal [ Array(12) ]` in
  merge-group run
  [42676200917](https://github.com/moq-dev/quest/actions/runs/42676200917).
- `lets a phase finish its cleanup once the enclosing scope signals it`:
  failed once in a local `quest gate just test` while iterating
  [moq-dev/quest#596](https://github.com/moq-dev/quest/pull/596), then passed
  three times alone and in a full rerun.

These are assertion failures, not timeouts, so the likely cause is a race in
the test's setup or in admission and scope signalling, not load alone. Gate
admission and scopes changed in
[moq-dev/quest#602](https://github.com/moq-dev/quest/pull/602) and
[moq-dev/quest#585](https://github.com/moq-dev/quest/pull/585), and
[moq-dev/quest#607](https://github.com/moq-dev/quest/pull/607) is changing
them again: start from whichever has landed, and find the PR that caused
each race by `git blame` once it is reproduced.

Decided 2026-11-10 (user, /quest-plan follow-up from /quest-complete):

- Scope: ✅ its own quest, separate from the timeout work (rejected: fold
  into the test CPU timeout quest; leave it to the
  flaky-test watcher).
- Milestone: ✅ m0 (rejected: m1).
