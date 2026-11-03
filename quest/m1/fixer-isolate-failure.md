# [S] One PR's collection failure can't stall its fixer job

## Goal

When collecting a land fixer job fails for one PR, the failure is recorded
on that PR alone, and a PR whose handback keeps failing is set aside after a
bounded number of attempts. The job's other PRs are still requeued or handed
back on their own merits. A test with one PR whose GitHub calls always fail
shows its siblings moving on.

## Plan

From moq-dev/moq.pro's land gate on 2026-11-02: a PR that merged while its
batch was parked wedged the fixer job for about 7 hours. Collection retried a
refused `disablePullRequestAutoMerge` every minute, the PRs behind it never
moved, and the job-wide `job.error` the retry wrote would have handed them back
with the wrong reason. [moq-dev/quest#392](https://github.com/moq-dev/quest/pull/392)
fixed that cause narrowly (a merged or closed PR is dropped).

- In `collectFixers` (`src/cli/land-fixer.ts`), write a collection error to
  `job.handbacks[<pr>]`, not `job.error`. Use the job-wide error only when no
  PR is left. A reason already recorded, such as a crash, still wins.
- After N consecutive failed collections of the same PR, hand it back (or park
  it) with the error and shift it off `job.numbers`, so a persistent GitHub
  error can't block the rest.
- The closed duplicate [moq-dev/quest#393](https://github.com/moq-dev/quest/pull/393)
  has a tested version of the first point; reuse it.
- The host gate is frozen except for fixes the queue-watcher switch needs, but
  moq.pro still lands through it. Confirm the change also covers the watcher's
  fixer path, or record that it only applies to the gate.

## Related

- [The land fixer resolves every mechanical failure itself](/quest/m0/land-fixer/README.md) - owns what the fixer does with a PR
