# [XS] quest status reports landing and checks as they are now

## Goal

`quest status` stops printing a `landing-stopped` line once the PR has been
queued again, including through `quest merge --land`. A required check whose
newest run passed counts as passed, even if an older run of it was
cancelled.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run).

- `summarize` in `src/cli/status.ts` takes the last removal, auto-merge
  disable, or ejection comment from the timeline, even if auto-merge was
  turned on again later. Drop the line when auto-merge's `enabledAt`, or a
  merge-queue entry, is newer than that event.
- Checks are classified one context at a time in `summarize` (`classifyCheck`).
  A cancelled run and a newer passing run of the same check both count, so
  the check still shows as failing. Count only the newest run of each check
  name.

Moved from m2 to m0 on 2026-11-01 (user, /quest-plan of the follow-ups from
the 2026-11-01 `/quest-complete` sessions): ✅ m0, beside the land quests ·
leave it in m2. The moq-dev land gate and the agents picking merges read
`quest status` every day, so a stale `landing-stopped` line or a superseded
cancelled check sends them after PRs that are already queued and passing.
