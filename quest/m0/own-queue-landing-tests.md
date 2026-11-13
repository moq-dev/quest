# [S] Test the own queue's rare landing paths

## Goal

Every landing path in `src/cli/land-head.ts` that the watcher's own queue
still runs, as on moq-dev/moq.pro, has a test that drives it through the own
queue's fixture in `test/land.test.ts` (`fixerFixture` and the "watcher's own
queue" suite). Retiring `quest land serve`
([moq-dev/quest#707](https://github.com/moq-dev/quest/pull/707)) deleted the
serve tests that covered these, leaving them untested:

- restarting after pushing a prepared head, which accepts only the gate's own
  recorded merge
- a fallback push to the base that GitHub refuses, or that finds the base moved
- GitHub's transient "Repository not found" on a push, retried with bounded
  backoff
- 405/409 merge refusals retried while GitHub still reports a stale pin
- a prepared or API tree mismatch, which logs CRITICAL and ejects `tree_mismatch`
- merge and push tokens scoped to `workflows: write` only when the PR's
  commits or the base merge touch `.github/workflows`

## Plan

Decided 2026-11-13 (user, /quest-run pick round on #707): ✅ add this
follow-up quest (rejected: port the tests in #707; drop them). Port each
deleted serve test from `git show` of #707's base to the own queue rather than
writing new ones, keeping its assertions. A path the own queue cannot reach is
a finding: delete its code in `land-head.ts` instead of testing it.

## Related

- [Serial merge queue epic](/quest/m0/queue-watcher/README.md) - the watcher whose own queue runs these paths
