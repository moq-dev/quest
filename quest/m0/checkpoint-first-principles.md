# [S] Design checkpoint asks for the best long-term approach

## Goal

At `/quest-review`'s design checkpoint, the agent steps back, works out the
best long-term approach from first principles, and compares it with the
current one before making another fix, so PRs stop piling up
just-one-more-change patches. Agents that loop on review findings often
change course once someone asks whether there is a better alternative; the
checkpoint should ask that question for them.

The checkpoint's trigger stays as `nextStep` in `src/cli/review.ts`
decides it today, and the agent still hands the choice to the user. Loops
outside `quest review`, such as `/quest-iterate` fixing CI failures or
online reviewers' comments, are out of scope.

## Plan

Decided 2026-11-12 (user, /quest-plan):

- What should change?
  - ✅ Strengthen the existing checkpoint: the `next checkpoint` line
    `nextStep` prints in `src/cli/review.ts` and the checkpoint paragraph in
    `assets/skills/review.md` (rejected: also counting `/quest-iterate`'s fix
    cycles, which adds a second round counter; having the agent rethink on
    its own and hand off only when it recommends a change of course)

  Agents follow the printed `next` line, and today it only says "reconsider
  the approach". So the line itself should carry the step back (the best
  long-term design from first principles, compared with the current one),
  not only point at the skill. Keep it short enough to read as one
  instruction.
- Which milestone?
  - ✅ m0 (rejected: m1, m2): agents loop on moq-dev's own PRs now.

Recommended: reword the skill paragraph so the agent first states the
problem the PR solves without reference to the current code, designs what
it would build if starting today, then compares that with the current
approach and the remaining findings. Keep its existing outcomes (continue,
rethink, merge as is, drop), the `Design change:` comment, and restarting
the count with `quest review --new`. Update the `quest review --help` text
in `src/cli/main.ts` that describes the checkpoint. The `nextStep` tests in
`test/review.test.ts` match only the `next checkpoint: ` prefix, so make
them assert that the line carries the step back, or the rewording could
regress unnoticed.
