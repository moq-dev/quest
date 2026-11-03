# [XS] quest status reports landing as it is now

## Goal

`quest status` stops printing a `landing-stopped` line once the PR has been
queued again, including through `quest merge --land`.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run).

- `summarize` in `src/cli/status.ts` takes the last removal, auto-merge
  disable, or ejection comment from the timeline, even if auto-merge was
  turned on again later. Drop the line when auto-merge's `enabledAt`, or a
  merge-queue entry, is newer than that event.

Moved from m2 to m0 on 2026-11-01 (user, /quest-plan of the follow-ups from
the 2026-11-01 `/quest-complete` sessions): ✅ m0, beside the land quests ·
leave it in m2. The moq-dev land gate and the agents picking merges read
`quest status` every day, so a stale `landing-stopped` line sends them after
PRs that are already queued.

Its other half, counting only the newest run of each check, moved to
[Checks are judged by their latest run](/quest/m0/latest-check-runs.md) on
2026-11-02 for its fuller plan, which also covers `quest wait`, the gate, and
the Worker. It stays in m0 beside this quest.

## Related

- [Checks are judged by their latest run](/quest/m0/latest-check-runs.md) - superseded runs stop failing `quest status`, `quest wait`, and the gate
