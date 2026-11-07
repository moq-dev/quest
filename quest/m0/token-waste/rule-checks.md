# [M] Mechanical rules become checks

## Goal

The rules in `assets/CONTEXT.md` that a program can check are enforced by
checks instead of prose: no em dashes in what agents write, `git push` with
an explicit refspec, never `git rebase` or a force-push, the
`(Written by <model> ...)` footer on GitHub posts, and scratch files in the
checkout's `.tmp/` rather than `/tmp`. Each check blocks the action with a
message that says what to do instead, and the prose it replaces leaves the
always-loaded rules.

## Plan

Decided 2026-11-05 (user, adopting practices for the
[token waste](/quest/m0/token-waste/README.md) epic). Sources: Claude Code's
best practices ("if you keep adding emphasis, it belongs in a hook"),
HumanLayer ("never send an LLM to do a linter's job"), and t3code, which
enforces its prose rules with custom lint rules.

Why: `quest context` and `quest guide` load about 260 instruction sentences
before every task, against the 150-200 published guidance says models follow
reliably. A rule that a check enforces no longer needs reading.

Recommendations for the implementer:

- Deliver Claude Code `PreToolUse` hooks (Bash for `git push`, `git rebase`,
  `--force`, `/tmp` writes, and `gh` post bodies; Write and Edit for em
  dashes) at user level through `quest setup`, as a row each in `HOOKS` and a
  case each in `quest hook` (`src/cli/hooks.ts`), beside its `SessionStart`
  and `SubagentStart` entries, since repositories write no hooks. Give Codex
  the equivalent `hooks.json` entries where its hooks can match.
- Codex parity for the always-on rules too (coordinator, 2026-11-05,
  follow-up of [moq-dev/quest#517](https://github.com/moq-dev/quest/pull/517),
  which gave Claude Code the `SessionStart` rules hook and Codex none):
  `quest setup` writes the same `SessionStart` entry (`compact` included)
  to `~/.codex/hooks.json`, with an `additionalContextLimit` that fits the
  rules. `quest review` runs Codex with `--ignore-user-config`; confirm in
  a review transcript that this keeps the user hook out of reviews, and
  keep it out if not. Codex asks to trust each hook once through `/hooks`.
- Keep a check narrow enough that it never blocks legitimate work: a force
  push the user asked for, an em dash quoted from someone else, `/tmp` used
  by a tool rather than for agent scratch. A check that cannot tell these
  apart stays prose.
- Remove each enforced rule from `assets/CONTEXT.md` in the same PR, and say
  in the PR body which rules stayed prose and why.
