# [M] Review by size

## Goal

`quest review` picks its reviewer from a ranked list built into `quest`
for the PR's size: the first entry whose model's maker differs from every
implementer's and that can run (CLI installed, logged in, under its usage
limit). Cheaper models review smaller PRs; frontier models lead for large
ones. A quest PR's size is its quest's; any other PR, such as a
`/quest-plan` PR, is sized by the skill that opens it. Without a size, a
review uses M's list. A repository's `AGENTS.md` may override the lists in
prose, which the reviewing session passes as `--harness`, `--model`, and
`--effort`.

## Plan

Decided 2026-11-04 (user, /quest-plan follow-ups of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)):

- Review effort drops one tier and scales with size: Codex `gpt-6.1-sol`
  medium for XS and S, high for M and sizeless PRs, xhigh for L and XL;
  Claude `claude-opus-5-5` low, medium, and high at the same sizes. L and
  XL share a tier (rejected: graduated). Claude has no effort below low,
  so XS and S share one too.
- What do PRs without a quest size get?
  - ✅ M's list, and PRs from skills such as `/quest-plan` carry a size of
    their own (user)
  - Today's pins
  - The small tier
- Should reviews rank Grok and opencode too?
  - ✅ Yes, always from a different maker than the implementer (user);
    reviews can use cheaper models than coding
  - No, Claude and Codex only
- Free models? ✅ Never (user).

The lists, in the module [routing](/quest/m0/model-routing/models.md)
shares, whichever lands first creating it:

| PR size | Ranked reviewer harness, model, effort |
|---|---|
| XS, S | opencode `opencode-go/deepseek-v4-pro` high → grok `grok-4.7` high → codex `gpt-6.1-sol` medium → claude `claude-opus-5-5` low |
| M, or none | grok `grok-4.7` xhigh → opencode `opencode-go/deepseek-v4-pro` high → codex `gpt-6.1-sol` high → claude `claude-opus-5-5` medium |
| L, XL | codex `gpt-6.1-sol` xhigh → claude `claude-opus-5-5` high → grok `grok-4.7` xhigh → opencode `opencode-go/deepseek-v4-pro` high |

The Codex and Claude efforts are the user's; the order and the Grok and
DeepSeek entries are the agent's choice, for the
[model check](/quest/m1/model-check.md) to retune. Online reviewers add
cheap opinions on every PR already: Pullfrog reviewed
[moq-dev/quest#488](https://github.com/moq-dev/quest/pull/488) with
`glm-5.3-flash`, and CodeRabbit runs too.

- `MODELS` in `src/cli/review.ts` becomes these lists. This replaces the
  2026-11-03 efforts (Codex xhigh, Claude high) recorded in the
  [model check](/quest/m1/model-check.md), which audits the lists each
  milestone; the PR updates its Plan.
- The implementers' makers come from the PR body's record
  ([PRs record their implementer](/quest/m0/model-routing/implementer.md)),
  passed by the reviewing session as `--exclude-maker`; without a record,
  the reviewing session's own maker is excluded, as "the other vendor" is
  today.
- Where the size comes from, read by the reviewing session, never from the
  head's files, so a change cannot lower its own review:
  - A quest branch: its quest's size, read from the base branch's tip, as
    `REVIEW.md` is. The branch is the quest's path without `.md`.
  - Any other branch: `quest review --size <XS|S|M|L|XL>`. `/quest-plan`,
    `/quest-audit`, and every other skill that opens its own PR size it as
    a quest is sized and pass it.
  - Otherwise M.
- A round's reviewer keeps its session across rounds; when it hits its
  usage limit mid-review, the next round starts a new session on the next
  entry, with `--new`, and says so in `## Review`.
- `quest context`'s Reviews section says to pass the override flags when
  the repository's `AGENTS.md` names other reviewers.
- The PR body's record, beside `## Review`, names the PR's size with its
  implementer and reviewer.

## Required

- [Grok and opencode reviewers](/quest/m0/model-routing/review-harnesses.md) - `quest review` runs them read-only, as it runs Claude Code and Codex
