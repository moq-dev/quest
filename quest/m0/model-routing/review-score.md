# [S] Reviews score the change out of 10

## Goal

Every `quest review` round reports, beside its findings, a score from 0 to
10 for how ready the reviewed head is to land, with one sentence on why.
The PR body's `## Review` record shows each round's score, so the
[model check](/quest/m1/model-check.md) can compare implementers and
reviewers by score as well as by rounds and findings.

## Plan

Decided 2026-11-04 (user, /quest-plan of `/quest-council`): each
`/quest-review` includes a score out of 10. It applies to single reviews
now; [the council](/quest/m2/council.md) reports each member's score.

- Add a required integer `score` (0 to 10) and a `rationale` string to
  `SCHEMA` in `src/cli/review.ts`, asked for in the schema turn, and print
  `score <n>` beside `findings <n>`. A reply without a valid score fails
  as a malformed reply does.
- Define the scale in the reviewer prompt so every reviewer reads it the
  same way: 10 lands as is, 7 to 9 lands after the findings are fixed,
  4 to 6 needs rework, 0 to 3 is the wrong approach. A round with no
  unrefuted findings can still score below 10, for example a working
  change that is harder to maintain than it needs to be.
- `quest context`'s Reviews section adds the score to the `## Review`
  record and to the score the user sees in `/quest-review`'s summary.
  Never block on a score: the findings and their refutations still decide
  the loop.
