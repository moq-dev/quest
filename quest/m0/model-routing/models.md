# [M] /quest-spawn routes each quest by MODELS.md

## Goal

A repository's optional `MODELS.md` maps each quest size to a harness,
model, and effort. `quest unblocked --json` reports the mapped harness,
model, and effort for each ready quest, and `/quest-spawn` starts each quest
on them. Without the file, or for a size it leaves out, spawns behave as
today. moq-dev/quest gets its own `MODELS.md`.
[Review effort by size](/quest/m0/model-routing/review-effort.md) adds its
reviewers.

## Plan

Decided 2026-11-04 (user, /quest-plan); the evidence and the mapping are in
[the epic](/quest/m0/model-routing/README.md).

- Where is `MODELS.md` parsed?
  - ✅ In quest's code: `quest unblocked --json` adds `harness`, `model`,
    and `effort` (null when unmapped) per quest, and `quest check` reports
    a malformed file
  - Skill prose only, read by the coordinator
- Should `MODELS.md` also set the reviewers?
  - ✅ Yes, and by PR size (refined later on 2026-11-04);
    [Review effort by size](/quest/m0/model-routing/review-effort.md) owns it
  - No, keep only the code pins
- When the mapped harness cannot run (its CLI missing, logged out, or at a
  usage limit), what happens to the quest?
  - ✅ Skip it and report the outage once in the spawn's summary
  - Start it on the session's own harness

Format (agent's choice): a file at the repository root, beside
`REVIEW.md`, whose implementation table has columns
`Size | Harness | Model | Effort`, leaving room for the review table
[Review effort by size](/quest/m0/model-routing/review-effort.md) adds.
Prose around the tables is free, so the file can explain its choices.
`quest check` reports an unknown harness or size, a duplicate row, and a
model or effort that is not a plain word (the rule `codexFlags` in
`src/cli/agent.ts` already applies). It does not check that a CLI accepts
the model.

This repository's file maps XS Codex `gpt-6.1-sol` high, S Codex
`gpt-6.1-sol` xhigh, M Claude `claude-opus-5-5` medium, L Claude
`claude-opus-5-5` high, XL Claude `claude-opus-5-5` xhigh.

- `quest unblocked` reads `MODELS.md` from the same upstream tree it ranks.
- `/quest-spawn`: start a quest whose harness matches the session's as a
  native sub-agent with the mapped model and effort, and one on the other
  vendor through `quest agent` on the logged-in account. An unmapped quest
  inherits the session's settings. Skip a quest whose harness cannot run
  (`quest agent` fails to start it, or exits on a usage limit) and report
  that harness's outage once, with the quests it held back.
- Docs: the README documents `MODELS.md` and `quest unblocked --json`'s
  new fields.

## Required

- [Headless agents](/quest/m0/helpers/headless-agents.md) - `quest agent` runs on the logged-in account, so a session can start the other vendor's agents

## Related

- [Reviewer usage limits](/quest/m0/review-quota.md) - its usage-limit exit is how `quest agent` reports a harness at its limit
