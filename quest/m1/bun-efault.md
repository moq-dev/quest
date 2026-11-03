# [XS] Bun's EFAULT on concurrent rmSync

## Goal

oven-sh/bun has a report for `rmSync(file, { force: true })` throwing
`EFAULT` on Windows when two processes remove the same file at once. Node
throws `EPERM` there. Once a Bun release fixes it and Quest's pin includes
that release, `remove()` in `src/cli/gate.ts` stops tolerating `EFAULT`, and
this quest is deleted.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR /quest-complete run). Posting the report to oven-sh/bun is approved.

- [moq-dev/quest#233](https://github.com/moq-dev/quest/pull/233) found the
  race and worked around it. Its diagnostic runs have the minimal repro: two
  processes `rmSync` the same file on `windows-11-arm` and `windows-2022`.
- Search existing Bun issues first, and comment on a match instead of opening
  a duplicate. As of 2026-11-02 nobody from moq-dev has commented or opened
  one. The closest reports are
  [oven-sh/bun#39708](https://github.com/oven-sh/bun/issues/39708), the
  recursive case, with its fix
  [oven-sh/bun#39710](https://github.com/oven-sh/bun/pull/39710), and the
  single-file fix
  [oven-sh/bun#38550](https://github.com/oven-sh/bun/pull/38550); all three
  are open.

## Waiting

- oven-sh/bun: a release fixes `rmSync` throwing `EFAULT` when two processes
  remove one file on Windows, and Quest's pin includes it. Check the report
  and the fix PRs above each time ready work is triaged.
