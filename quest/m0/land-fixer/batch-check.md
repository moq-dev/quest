# [XS] The daemon runs quest check on the batch before the sandbox

## Goal

Before it spends a sandbox check on a batch, `quest land` runs `quest check`
on the batch's combined squash chain inside the daemon. A failure there is
blamed on the link that introduced it, the same way
[Batch triage](/quest/m0/land-fixer/triage.md) blames a failing check: that
PR is parked for the fixer, and the batch is rebuilt without it. No sandbox
time is spent.

## Plan

Decided 2026-11-01 (maintainer, from the audit of the merge-queue plan; see
the [epic](/quest/m0/land-fixer/README.md)). In the audit's 24 hours on moq,
`check quest` was the first failing module in 9 of 66 failed batches (about
14%), even though each PR passed `quest check` alone. Two PRs can each pass
alone yet together leave a dangling link or a `Required` cycle. The daemon
already screens each candidate alone (`screener()` in `src/cli/land.ts`), and
`quest check` on the chain tip costs well under a second, so check the chain
too.

## Required

- [Batch triage](/quest/m0/land-fixer/triage.md) - provides parking and blame
