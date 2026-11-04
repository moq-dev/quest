# [S] quest waiting lists draft PRs' Waiting items

## Goal

`quest waiting` lists each open draft PR's `## Waiting` items beside the
quest tree's, ranked the same way with the maintainer's first, so one
command shows everything that waits on someone. `/quest-unblock` reads it
instead of gathering draft bodies with `gh` itself.

## Plan

Decided 2026-11-02 (user, /quest-spawn follow-ups): ✅ plan as stated
(rejected: drop it); ✅ m0 (rejected: m1, m2).

- Raised by [moq-dev/quest#411](https://github.com/moq-dev/quest/pull/411):
  a reviewer outage lives in the draft's `## Waiting`, which `quest waiting`
  never reads. Drafts handed back for decisions carry theirs there too.
- Read drafts of the repository's own PRs, parsing `## Waiting` (and the
  older `## Decisions needed` until
  [its retirement](/quest/m1/decisions-needed.md)) with the claim code that
  already detects the heading. Each item names its PR's URL.
- Keep `quest waiting` usable offline: without GitHub access it prints the
  tree's items and says the drafts were skipped.
- Update `assets/skills/unblock.md` to read the command's output, keeping
  its per-draft `quest status <pr>` hold check, so it still skips a draft
  another session holds.
