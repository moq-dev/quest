# [M] Review effort by size

## Goal

`quest review` runs the reviewer at the model and effort `MODELS.md` gives
the PR's size: smaller PRs get cheaper reviews, larger ones deeper. A quest
PR's size is its quest's; any other PR, such as a `/quest-plan` PR, is sized
by the skill that opens it. Without a size, or without the file, a review
runs at M's tier, which becomes quest's built-in default.

## Plan

Decided 2026-11-04 (user, /quest-plan follow-up of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)): reviews
drop one tier, scaled by size.

| PR size | Codex reviews Claude's work | Claude reviews Codex's work |
|---|---|---|
| XS, S | `gpt-6.1-sol` medium | `claude-opus-5-5` low |
| M, or none | `gpt-6.1-sol` high | `claude-opus-5-5` medium |
| L, XL | `gpt-6.1-sol` xhigh | `claude-opus-5-5` high |

- How do L and XL step up?
  - ✅ Both one tier above M, today's pins
  - Graduated, XL a tier above L
- What do PRs without a quest size get?
  - ✅ M's tier, and quest PRs from skills such as `/quest-plan` carry a
    size of their own (user)
  - Today's pins
  - The small tier

  Claude has no effort below low, so XS and S share a tier.

- `MODELS.md` gains a review table: size, reviewer harness, model, effort
  (format is the implementer's choice, parsed and checked with the
  implementation table from
  [Route by MODELS.md](/quest/m0/model-routing/models.md)). This
  repository's file holds the table above.
- `MODELS` in `src/cli/review.ts` becomes M's tier, Codex high and Claude
  medium, as the default for a size `MODELS.md` leaves out or a repository
  without one. This replaces the 2026-11-03 efforts (Codex xhigh, Claude
  high) in the [review harness check](/quest/m1/review-harness.md), whose
  next run compares the pins and this repository's review table with each
  vendor's current models.
- Where the size comes from, read by the reviewing session, never from the
  head's files, so a change cannot lower its own review:
  - A quest branch: its quest's size, read from the base branch's tip, as
    `REVIEW.md` is. The branch is the quest's path without `.md`.
  - Any other branch: `quest review --size <XS|S|M|L|XL>`. `/quest-plan`,
    `/quest-audit`, and every other skill that opens its own PR size it as
    a quest is sized and pass it.
  - Otherwise M.
- `--effort` and `--model` still override.
- The PR body's record, beside `## Review`, names the PR's size with its
  implementer and reviewer, so each PR reads as size, who wrote it, and who
  reviewed it at what effort.
  [PRs record their implementer](/quest/m0/model-routing/implementer.md)
  writes that record.

## Required

- [Route by MODELS.md](/quest/m0/model-routing/models.md) - the `MODELS.md` format and parser the review table extends
