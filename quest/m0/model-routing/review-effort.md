# [M] Review by size

## Goal

`quest review` reviews with Sol at the effort its built-in list gives the
PR's size, and with Opus when Sol wrote the code, so no PR is reviewed by
the model that wrote it. A quest PR's size is its quest's; any other PR,
such as a `/quest-plan` PR, is sized by the skill that opens it. Without a
size, a review uses M's. A repository's `AGENTS.md` may override the list
in prose, which the reviewing session passes as `--harness`, `--model`, and
`--effort`.

## Plan

Decided 2026-11-04 (user, /quest-plan follow-ups of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)), replacing
earlier ranked lists of Grok, DeepSeek, Sol, and Opus reviewers:

| PR size | Reviewer | When Sol wrote the code |
|---|---|---|
| XS | codex `gpt-6.1-sol` low | claude `claude-opus-5-5` low |
| S | codex `gpt-6.1-sol` medium | claude `claude-opus-5-5` low |
| M, or none | codex `gpt-6.1-sol` high | claude `claude-opus-5-5` medium |
| L | codex `gpt-6.1-sol` xhigh | claude `claude-opus-5-5` high |
| XL | codex `gpt-6.1-sol` xhigh | claude `claude-opus-5-5` high |

- The Sol column is the user's. Never the same model for coding and
  reviewing (user). The Opus column, for the XS, S, and M quests whose
  Sol fallback wrote the code, is the agent's choice: the Opus review
  efforts the user set earlier the same day. L and XL never fall back to
  Sol, so their Opus column applies only to a PR Sol wrote by hand.
- Pullfrog and CodeRabbit review every PR for free on top (user), so the
  local review stays one model.
- What do PRs without a quest size get?
  - ✅ M's reviewer, and PRs from skills such as `/quest-plan` carry a
    size of their own (user)
  - Today's pins
  - The small tier
- `MODELS` in `src/cli/review.ts` becomes this list, in the module
  [routing](/quest/m0/model-routing/models.md) shares, whichever lands
  first creating it. This replaces the 2026-11-03 efforts (Codex xhigh,
  Claude high) recorded in the [model check](/quest/m1/model-check.md),
  which audits the list each milestone; the PR updates its Plan.
- The implementers' models come from the PR body's `## Models` record,
  which `quest context`'s Reviews section defines, passed by the reviewing
  session as `--exclude-model`; without a record, the reviewing session's
  own model is excluded, as "the other vendor" is today.
- Where the size comes from, read by the reviewing session, never from the
  head's files, so a change cannot lower its own review:
  - A quest branch: its quest's size, read from the base branch's tip, as
    `REVIEW.md` is. The branch is the quest's path without `.md`.
  - Any other branch: `quest review --size <XS|S|M|L|XL>`. `/quest-plan`,
    `/quest-audit`, and every other skill that opens its own PR size it as
    a quest is sized and pass it.
  - Otherwise M.
- `quest context`'s Reviews section says to pass the override flags when
  the repository's `AGENTS.md` names other reviewers.
- The PR body's record, beside `## Review`, names the PR's size with its
  implementers and reviewer.
