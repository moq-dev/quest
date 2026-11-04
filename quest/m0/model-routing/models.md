# [M] /quest-spawn routes each quest down a ranked list

## Goal

The `quest` binary ranks harnesses and models for each quest size.
`quest unblocked --json` reports each ready quest's ranked list, and
`/quest-spawn` starts the quest on the first entry that can run: its CLI
installed, logged in, and under its usage limit. A quest is skipped only
when its whole list is out. A repository's `AGENTS.md` may override the
lists in prose; otherwise every repository gets the same ones.

## Plan

Decided 2026-11-04 (user, /quest-plan); the evidence is in
[the epic](/quest/m0/model-routing/README.md).

- Where does each quest's model come from?
  - ✅ Lists built into `quest`, the same for every repository; a
    repository's `AGENTS.md` overrides them in prose (user, replacing a
    `MODELS.md` file per repository)
  - A `MODELS.md` in each repository, parsed by `quest`
  - Per quest, in its plan
- One model per size, or a ranked list?
  - ✅ A ranked list, so a usage limit falls through to the next entry
    (user, replacing "skip the quest and report the outage")
- Which models? ✅ Opus writes the code from S up, since it does a much
  better job; Grok takes XS; Sol is the fallback through M; L and XL have
  no fallback and wait for Opus (user, replacing earlier lists that led S
  with Sol and listed DeepSeek and free models).
- A quest with an open decision? ✅ Routes one size up (user). The signal:
  a `Maintainer:` item under its `## Waiting`. An XL stays XL.

The lists, pinned in a module `src/cli/review.ts` also imports (user):

| Size | Ranked harness, model, effort |
|---|---|
| XS | grok `grok-4.7` high → codex `gpt-6.1-sol` medium |
| S | claude `claude-opus-5-5` medium → codex `gpt-6.1-sol` high |
| M | claude `claude-opus-5-5` high → codex `gpt-6.1-sol` xhigh |
| L | claude `claude-opus-5-5` xhigh |
| XL | claude `claude-opus-5-5` xhigh |

- Each entry names its model, so [reviews](/quest/m0/model-routing/review-effort.md)
  never use the model that wrote the code.
- `quest unblocked --json` adds the ranked list per quest, after the
  decision bump. An epic whose README carries no size has none; the
  spawner then inherits its own settings.
- `/quest-spawn`: follow the repository's `AGENTS.md` where it names other
  models, and otherwise the list. Start a quest on a harness matching the
  session's as a native sub-agent, and any other through `quest agent` on
  the logged-in account. When `quest agent` cannot start an entry (CLI
  missing, logged out) or the agent exits on a usage limit, move to the
  next entry, resuming from the claim PR and checkout. With no entry left,
  skip the quest. Report each harness's outage once.
- Docs: the README documents the lists, the decision bump, the override,
  and `quest unblocked --json`'s new field. The
  [model check](/quest/m1/model-check.md) audits the lists each milestone.

## Required

- [Grok agents](/quest/m0/model-routing/agent-harnesses.md) - `quest agent` starts Grok as well as Claude Code and Codex
