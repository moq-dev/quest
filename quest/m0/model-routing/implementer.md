# [XS] PRs record their implementer

## Goal

Each PR's body names the PR's size and the harness, model, and effort of
every session that pushed commits to it, beside `## Review`, which already
names the reviewer's harness, model, and effort. Each PR then reads as its
size, who wrote it, and who reviewed it at what effort, so `quest`'s size tables can
be retuned from outcomes such as review rounds per model and size.

## Plan

Decided 2026-11-04 (user, /quest-plan): every PR records the implementing
harness, model, and effort, and the reviewer and its effort (user,
follow-up of [moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)).
`quest context`'s Reviews section (`assets/CONTEXT.md`) already requires the latter in `## Review`; keep
it, and put the size and implementer beside it. A quest PR's size is its
quest's; a skill's own PR, such as `/quest-plan`'s, is sized by that skill,
as [Review by size](/quest/m0/model-routing/review-effort.md) uses.

- `quest context`'s Reviews section, beside the `## Review` rule, says what
  the record holds and that each session adds its own line when it pushes, so a quest
  that `/quest-iterate` finishes on another model lists both.
- An agent finds its own settings rather than guessing: Claude Code
  exports `CLAUDE_EFFORT` and knows its model. Find where Codex exposes
  its model and `model_reasoning_effort` to the agent, and name it in the
  rule. When an agent cannot find its effort, it writes `unknown` rather
  than leaving the line out.
