# [M] Hand looping PRs to Fable in half the cases

## Goal

A `/quest-iterate` on a PR whose review has run past a threshold of rounds
runs, 50/50 and stable per PR, either on the PR's writer as today or on
Fable 5.2 medium. Its `Implementer:` line records the arm, and `quest usage`
reports the rounds left to merge, findings fixed and refuted, hand-backs,
later culprits, and cost per arm, for the
[routing evidence](/quest/m0/routing-evidence/README.md) readout.

## Plan

Follow-up of the 2026-11-13 routing change (user). Theo Browne's
[Opus against Fable video](https://www.youtube.com/watch?v=XtykeVoSmP8)
finds that Opus applies every review finding, so a small PR keeps growing,
while Fable fixes what Opus could not or judges the rest good enough to
merge. Opus low on S quests averaged 4.7 review rounds over 6 reviewed PRs
in `quest usage` since 2026-10-01.

Agent's choices, for the implementer to revisit:

- Threshold: past round 4. Most PRs merge by then, so the arms take only
  the loops.
- Read the round count from the `## Review` record's tally, as `quest
  usage` already does, and pick the arm from a hash of the PR's branch, as
  [the writer A/B](/quest/m0/routing-evidence/writer-ab.md) does for
  quests.
- The reviewer pick avoids models by exact id, not family, so it avoids only
  `claude-fable-5-2` when Fable wrote last; Sol, first in every size's
  reviewer list, keeps reviewing such a PR.
- Record the arm on the Implementer line as `(iterate, S, unstick)` or
  `(iterate, S, writer)`.

## Required

- [usage through token-max](/quest/m0/routing-evidence/usage-token-max.md) -
  counts sub-agent writers' cost, without which an arm's cost is undercounted
