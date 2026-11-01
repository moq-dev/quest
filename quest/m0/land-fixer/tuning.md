# [S] Tune batching and the fixer for throughput

## Goal

Once failing PRs are parked instead of ejected, the gate stops paying for
choices made while a failure ejected a whole batch:

- Batch size follows the measured per-PR failure rate, not halving on each
  failure.
- A conflict on the batch's base PR parks that PR and fills the batch in the
  same round, without spending a round on it.
- The gate's repository enables `git rerere`, so it replays conflict
  resolutions it has already made.
- Concurrent fixer jobs are capped and run below the batch check's priority.
- The fixer runs with an explicit reasoning effort; today Codex reports
  `reasoning effort: none`.

## Plan

Decided 2026-11-01 (maintainer, from the audit of the merge-queue plan; see
the [epic](/quest/m0/land-fixer/README.md)). Audit findings on moq's 24 hours:

- Halving after each failure kept batches at 2-3 PRs. With failing PRs
  parked, size from the recent failure rate instead (about 4-5 at today's
  rate), keeping `batch-policy.json` as the state.
- 156 rounds were a base-PR conflict that ran no check, about 1.5-2.5 hours
  of lane time a day.
- 44 of 79 conflicting PRs conflicted 2-7 times; `rerere` lets the gate's
  own base merges replay resolutions.
- Seven fixer jobs started within three minutes on a host already at load
  18-25 of 32 cores, and timeouts under load caused several flaky failures.
- Fixer job logs show `reasoning effort: none`. `land-fix.ts` passes a model
  but no `model_reasoning_effort`; set one, defaulting to `medium`, with a
  daemon option to override it.
