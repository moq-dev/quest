# [M] /quest-spawn routes each quest by size

## Goal

The `quest` binary maps each quest size to a harness, model, and effort.
`quest unblocked --json` reports them for each ready quest, and
`/quest-spawn` starts each quest on them, unless the repository's
`AGENTS.md` overrides the mapping. Every repository gets the same mapping.

## Plan

Decided 2026-11-04 (user, /quest-plan); the evidence is in
[the epic](/quest/m0/model-routing/README.md).

- Where does each quest's model come from?
  - ✅ A table built into `quest`, the same for every repository; a
    repository's `AGENTS.md` overrides it in prose (user, later on
    2026-11-04, replacing a `MODELS.md` file per repository)
  - A `MODELS.md` in each repository, parsed by `quest`
  - Per quest, in its plan
- When the mapped harness cannot run (its CLI missing, logged out, or at a
  usage limit), what happens to the quest?
  - ✅ Skip it and report the outage once in the spawn's summary
  - Start it on the session's own harness

The table, pinned beside `MODELS` in `src/cli/review.ts` in a module both
it and [Review effort by size](/quest/m0/model-routing/review-effort.md)
import:

| Size | Harness | Model | Effort |
|---|---|---|---|
| XS | codex | `gpt-6.1-sol` | high |
| S | codex | `gpt-6.1-sol` | xhigh |
| M | claude | `claude-opus-5-5` | medium |
| L | claude | `claude-opus-5-5` | high |
| XL | claude | `claude-opus-5-5` | xhigh |

- `quest unblocked --json` adds `harness`, `model`, and `effort` per quest.
  An epic whose README carries no size has none and reports null; the
  spawner then inherits its own settings.
- `/quest-spawn`: follow the repository's `AGENTS.md` where it names other
  models or efforts, and otherwise `quest unblocked`'s. Start a quest whose
  harness matches the session's as a native sub-agent with that model and
  effort, and one on the other vendor through `quest agent` on the
  logged-in account. Skip a quest whose harness cannot run (`quest agent`
  fails to start it, or exits on a usage limit) and report that harness's
  outage once, with the quests it held back.
- Docs: the README documents the table, the override, and `quest unblocked
  --json`'s new fields. The [model check](/quest/m1/model-check.md) audits
  this table each milestone.

## Required

- [Headless agents](/quest/m0/helpers/headless-agents.md) - `quest agent` runs on the logged-in account, so a session can start the other vendor's agents

## Related

- [Reviewer usage limits](/quest/m0/review-quota.md) - its usage-limit exit is how `quest agent` reports a harness at its limit
