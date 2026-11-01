# [S] Only a failed fix spends a pick's attempt

## Goal

A maintainer pick's single fixer attempt is spent only when a head the fixer
pushed fails again, or when the fixer hands back. A "requeued unchanged"
verdict, and a fix that only merged the base (cleanly or with resolved
conflicts) leave the attempt unspent. A PR that conflicts again as the base
moves is then fixed again without a re-pick.

## Plan

Decided 2026-11-01 (user, /quest-plan of the land fixer audit; see the
[epic](/quest/m0/land-fixer/README.md)). In 2026-10-30 to 11-01, 98 handbacks
said only "This maintainer pick already used its mechanical fix attempt", and
each needed a manual re-pick. Most had spent the attempt on a requeue-unchanged
verdict as collateral of another PR's failure, or on an earlier conflict fix
before the base moved again.

- How attempts count:
  - ✅ Only failed fixes count: requeue-unchanged and base-merge fixes leave
    the attempt unspent; it is spent when a pushed fix fails again, or on a
    handback
  - One attempt per head
  - N attempts per pick (for example 3)
  - Keep one per pick

The attempt record is `fix-attempt-<n>.json` (`src/cli/land-fixer.ts`): its
`pick`, `requeued`, and `head` fields, read by `handbackRepeated`. Record the
kind of each outcome (`unchanged`, `merged`, `fixed`) and stop counting the
first two. A head the fixer changed beyond a base merge that then fails its
checks still hands back, so a bad fix cannot loop.

[Batch triage](/quest/m0/land-fixer/triage.md) keeps a collateral ejection
from reaching the fixer at all; this quest owns the counting rule for every
outcome, including the ones triage still produces.

## Related

- [Batch triage](/quest/m0/land-fixer/triage.md) - blames one PR, so collateral PRs are not ejected
