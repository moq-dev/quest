# [S] Count hand-backs on merged PRs

## Goal

`quest usage` counts a PR as handed back when any version of its body had a
`## Waiting` (or `## Decisions needed`) section while it was a draft, merged
PRs included, so the writer A/B's and the model check's hand-back measure
sees every PR rather than only drafts still open.

## Plan

Decided 2026-11-14 (user, /quest-run, from
[moq-dev/quest#721](https://github.com/moq-dev/quest/pull/721)'s
follow-ups): add this quest rather than drop the measure.

Today `handedBack` in `src/cli/usage.ts` reads only the current body of an
open draft. `quest ready` and hand edits remove `## Waiting` before merge,
so every merged PR reads 0.

Recommended (agent's choice): read each PR's body history from GitHub
(GraphQL `userContentEdits`, whose entries carry each earlier body) where
`quest usage` already reads the PR, and count a hand-back when an earlier
body had a hand-back section, using `handedBack` from `src/core/claim.ts`.
It works on PRs merged before this lands and needs no change to the skills
or `quest ready`. The alternative, having `quest ready` record hand-backs
in `## Models`, counts only PRs readied after it lands and trusts every
writer to keep the record. Batch the history reads with the existing PR
query so `--since` over a week stays within the GraphQL rate limit.

Count each PR once, however many times it was handed back, and report the
count in the `accuracy` and per-PR rows as today.

## Related

- [Model check](/quest/m1/model-check.md) - charts hand-backs per PR
