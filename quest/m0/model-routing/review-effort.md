# [M] Review effort by size

## Goal

`quest review` runs the reviewer at the model and effort its built-in table
gives the PR's size: smaller PRs get cheaper reviews, larger ones deeper. A
quest PR's size is its quest's; any other PR, such as a `/quest-plan` PR,
is sized by the skill that opens it. Without a size, a review runs at M's
tier. A repository's `AGENTS.md` may override the table in prose, which the
reviewing session passes as `--model` and `--effort`. Every repository gets
the same table.

## Plan

Decided 2026-11-04 (user, /quest-plan follow-up of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)): reviews
drop one tier, scaled by size, from a table built into `quest` (user,
replacing a `MODELS.md` file per repository).

| PR size | Codex reviews Claude's work | Claude reviews Codex's work |
|---|---|---|
| XS, S | `gpt-6.1-sol` medium | `claude-opus-5-5` low |
| M, or none | `gpt-6.1-sol` high | `claude-opus-5-5` medium |
| L, XL | `gpt-6.1-sol` xhigh | `claude-opus-5-5` high |

- How do L and XL step up?
  - ✅ Both one tier above M, today's pins
  - Graduated, XL a tier above L
- What do PRs without a quest size get?
  - ✅ M's tier, and PRs from skills such as `/quest-plan` carry a size of
    their own (user)
  - Today's pins
  - The small tier

  Claude has no effort below low, so XS and S share a tier.

- `MODELS` in `src/cli/review.ts` becomes this table, in the module
  [Route by size](/quest/m0/model-routing/models.md) shares; whichever
  lands first creates it. This replaces the 2026-11-03 efforts (Codex
  xhigh, Claude high) recorded in the [model check](/quest/m1/model-check.md),
  which audits this table each milestone; the PR updates its Plan.
- Where the size comes from, read by the reviewing session, never from the
  head's files, so a change cannot lower its own review:
  - A quest branch: its quest's size, read from the base branch's tip, as
    `REVIEW.md` is. The branch is the quest's path without `.md`.
  - Any other branch: `quest review --size <XS|S|M|L|XL>`. `/quest-plan`,
    `/quest-audit`, and every other skill that opens its own PR size it as
    a quest is sized and pass it.
  - Otherwise M.
- `--effort` and `--model` still override, and the guide's Reviews section
  says to pass them when the repository's `AGENTS.md` names other reviewer
  settings.
- The PR body's record, beside `## Review`, names the PR's size with its
  implementer and reviewer.
  [PRs record their implementer](/quest/m0/model-routing/implementer.md)
  writes that record.
