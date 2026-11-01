# [S] Review harness check

## Goal

Each milestone, `quest review`'s pinned models are each vendor's newest for
their tier, and the reviewers still run nothing from a reviewed head.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)).

- Compare `MODELS` in `src/cli/review.ts` with each vendor's current models:
  the default tier is the newest general model at medium effort, and the deep
  tier the strongest one. Bump any that are stale, and check that both CLIs
  accept the new ids.
- Run [the live sandbox test](/quest/m0/review-sandbox.md) with the CLIs
  installed at the time, and plan a quest for any failure.
- This quest recurs. The PR that finishes this run creates
  `/quest/m1/review-harness.md` with this Goal, listed in m1's `Required`,
  and `Required: /quest/m0/README.md`, so the next run becomes ready when m0
  completes. Each run creates the next milestone's run the same way, carrying
  forward the model ids it found and anything to check first.

## Required

- [Live sandbox test](/quest/m0/review-sandbox.md) - the test each run executes
