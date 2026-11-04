# [M] Commits and PRs record their models

## Goal

Every commit an agent makes carries its harness, model, and effort in
trailers, and every PR's body names the PR's size and each implementing
session's harness, model, and effort beside `## Review`, which already
names the reviewer's. This covers quest PRs, skills' own PRs such as
`/quest-plan`'s, the land fixer's commits, and kix runner jobs, so the
[model check](/quest/m1/model-check.md) and
[`quest usage`](/quest/m1/usage.md) can audit how each ranking performs.

## Plan

Decided 2026-11-04 (user, /quest-plan follow-ups of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)): record the
model and effort for every commit and PR, to audit the rankings.

- Commit trailers (agent's choice of names): `Agent-Harness`,
  `Agent-Model`, and `Agent-Effort`, one each, beside the
  `Co-Authored-By` line a harness already adds. `quest context` tells
  agents to add them; the land fixer (`src/cli/land-fix.ts`) and the kix
  runner (`src/runner/`) add them in code, since no agent writes those
  commit messages.
- The PR record: `quest context`'s Reviews section (`assets/CONTEXT.md`)
  already requires the reviewer's harness, model, and effort in
  `## Review`, and a `## Models` section naming the PR's size and each
  implementing session's harness, model, and effort, which `quest review
  --size` and `--exclude-model` read ([moq-dev/quest#493](https://github.com/moq-dev/quest/pull/493)).
  Settle the section's line format, and say each session adds its line
  when it pushes, so a quest that `/quest-iterate` finishes on another
  model lists both.
- An agent finds its own settings rather than guessing: Claude Code
  exports `CLAUDE_EFFORT` and knows its model. Find where Codex and Grok
  expose their model and effort to the agent, and name them in the rule.
  When an agent cannot find its effort, it writes `unknown` rather than
  leaving the record out.
- Linking the PRs that caused later fixes is
  [its own quest](/quest/m0/model-routing/culprits.md).
