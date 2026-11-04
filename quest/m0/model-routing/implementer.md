# [XS] PRs record their implementer

## Goal

Each quest PR's body names the harness, model, and effort of every session
that pushed commits to it, beside `## Review`, so `MODELS.md` can be
retuned from outcomes such as review rounds per model and size.

## Plan

Decided 2026-11-04 (user, /quest-plan): every PR records the implementing
harness, model, and effort.

- The guide's Execution section (`assets/AGENTS.md`) says what the record
  holds and that each session adds its own line when it pushes, so a quest
  that `/quest-iterate` finishes on another model lists both.
- An agent finds its own settings rather than guessing: Claude Code
  exports `CLAUDE_EFFORT` and knows its model. Find where Codex exposes
  its model and `model_reasoning_effort` to the agent, and name it in the
  rule. When an agent cannot find its effort, it writes `unknown` rather
  than leaving the line out.
