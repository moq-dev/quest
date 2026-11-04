# [S] A job's head trust is rechecked when it queues

## Goal

kix rechecks a PR job's head trust whenever the job becomes queued, after an
answer or when a runner's lease expires, not only when a runner has a free
slot. A job whose head is no longer trusted shows the "Head to approve"
decision at once instead of sitting as "Queued" until a slot frees.

## Plan

Decided 2026-11-02 (user, /quest-spawn follow-ups): ✅ plan as stated
(rejected: drop it); ✅ m0 (rejected: m1, m2).

- Raised by [moq-dev/quest#402](https://github.com/moq-dev/quest/pull/402),
  which added per-head approval and rechecks trust at job creation and at
  assignment. Existing behaviour: a queued job's trust is reread only when a
  runner slot frees, so a job resumed after kix pushed new commits looks
  idle while it needs a maintainer.
- Reuse #402's trust classification; call it from every transition into
  `queued`. Keep the recheck at assignment as the authority.
- Test a resume after kix pushed, and a lease expiry, each surfacing the
  decision without a free runner slot.
