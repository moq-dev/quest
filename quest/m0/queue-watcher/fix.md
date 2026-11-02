# [M] The fixer runs on each dropped PR and the watcher re-enqueues it

## Goal

When the merge queue drops a picked PR for a failure or a conflict, the
watcher starts the Codex land fixer on it in the background, with the failing
build's log or the conflicting base. When the fixer fixes the PR, or judges
the failure flaky, the watcher re-enqueues the resulting head at the back of
the queue. When the fixer hands back, the watcher posts its comment and the
PR leaves the watcher's care. The queue keeps landing other PRs meanwhile.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)): re-enqueue at the back, and keep
going while each round makes progress.

- Reuse the host gate's fixer: `startFixer`, the detached supervisor, and
  `collectFixers` in `src/cli/land-fixer.ts`, the `qland-fix` container and
  its launcher, `validateFix`, the ready-commit handback for
  `quest land apply`, and the daemon posting the comments in the fixer's
  result. The fixer's input is one PR and the dropped head, so the batch
  blame step is unused.
- Re-enqueue with `enqueuePullRequest` (no `jump`) and `expectedHeadOid` set
  to the head the fixer pushed or the unchanged head, as moq-bot. A fix the
  fixer pushed carries its `## Review` record as a mechanical fix, as today.
- A conflict removal starts the fixer on a merge of the current base with the
  quest merge driver, as `prepareHead` (`src/cli/land-head.ts`) does.
- Carried over from the dropped
  [throughput tuning](https://github.com/moq-dev/quest/pull/376) plan, since
  they apply to any fixer: cap concurrent fixer jobs and run them below the
  queue's builds in `quest gate`, and pass an explicit
  `model_reasoning_effort` (default `medium`, with a daemon option), since
  fixer logs show `reasoning effort: none`.
- When to stop is [Stop rules](/quest/m0/queue-watcher/stop.md); flaky
  handling is [Flaky failures](/quest/m0/queue-watcher/flaky.md).

## Required

- [Queue removals](/quest/m0/queue-watcher/removals.md) - the removals and logs this acts on
