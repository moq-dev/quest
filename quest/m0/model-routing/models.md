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
- Which models? ✅ Grok for XS, Sol for S, Opus for M and up, each falling
  back down its list (user). Implementation is coding; reviews may use
  cheaper models ([Review by size](/quest/m0/model-routing/review-effort.md)).
- Free models? ✅ Never (user): they are slow, and they may log or train on
  a private repository's code.
- A quest with an open decision? ✅ Routes one size up, so it prefers Opus
  (user). The signal: a `Maintainer:` item under its `## Waiting`. An XL
  stays XL.

The lists, pinned in a module `src/cli/review.ts` also imports:

| Size | Ranked harness, model, effort |
|---|---|
| XS | grok `grok-4.7` high → opencode `opencode-go/deepseek-v4-pro` high → codex `gpt-6.1-sol` medium |
| S | codex `gpt-6.1-sol` high → claude `claude-opus-5-5` medium → grok `grok-4.7` high |
| M | claude `claude-opus-5-5` high → codex `gpt-6.1-sol` xhigh |
| L | claude `claude-opus-5-5` xhigh → codex `gpt-6.1-sol` xhigh |
| XL | claude `claude-opus-5-5` xhigh → codex `gpt-6.1-sol` xhigh |

The first entry of each list is the user's, as are the Sol, Opus, and Grok
efforts: Sol medium for XS, high for S, xhigh above; Opus high for M,
xhigh for L and XL; Grok high everywhere (user, 2026-11-04). The rest of
the fallbacks, the S list's Opus effort, DeepSeek's, and the opencode provider (OpenCode Go, the subscription kix
already supports) are the agent's choice, for the
[model check](/quest/m0/model-check.md) to retune.

- Each entry also names its model's maker (Anthropic, OpenAI, xAI,
  DeepSeek), which reviews use to pick a different maker than the
  implementer.
- `quest unblocked --json` adds the ranked list per quest, after the
  decision bump. An epic whose README carries no size has none; the
  spawner then inherits its own settings.
- `/quest-spawn`: follow the repository's `AGENTS.md` where it names other
  models, and otherwise the list. Start a quest on a harness matching the
  session's as a native sub-agent, and any other through `quest agent` on
  the logged-in account. When `quest agent` cannot start an entry (CLI
  missing, logged out) or the agent exits on a usage limit, move to the
  next entry, resuming from the claim PR and checkout; report each
  harness's outage once.
- Docs: the README documents the lists, the decision bump, the override,
  and `quest unblocked --json`'s new field. The
  [model check](/quest/m1/model-check.md) audits the lists each milestone.

## Required

- [More agent harnesses](/quest/m0/model-routing/agent-harnesses.md) - `quest agent` starts Grok and opencode as well as Claude Code and Codex

## Related

- [Reviewer usage limits](/quest/m0/review-quota.md) - its usage-limit exit is how `quest agent` reports a harness at its limit
