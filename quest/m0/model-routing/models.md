# [M] /quest-spawn routes each quest by MODELS.md

## Goal

A repository's optional `MODELS.md` maps each quest size to a harness,
model, and effort, and names each harness's reviewer. `quest unblocked
--json` reports the mapped harness, model, and effort for each ready quest,
`/quest-spawn` starts each quest on them, and `quest review` takes its
reviewer's model and effort from the base branch's `MODELS.md`. Without the
file, or for a size it leaves out, spawns and reviews behave as today.
moq-dev/quest gets its own `MODELS.md`.

## Plan

Decided 2026-11-04 (user, /quest-plan); the evidence and the mapping are in
[the epic](/quest/m0/model-routing/README.md).

- Where is `MODELS.md` parsed?
  - ✅ In quest's code: `quest unblocked --json` adds `harness`, `model`,
    and `effort` (null when unmapped) per quest, and `quest check` reports
    a malformed file
  - Skill prose only, read by the coordinator
- Should `MODELS.md` also set the reviewers?
  - ✅ Yes: a review row per harness overrides the pins in `MODELS` in
    `src/cli/review.ts`, which stay the defaults
  - No, keep only the code pins
- When the mapped harness cannot run (its CLI missing, logged out, or at a
  usage limit), what happens to the quest?
  - ✅ Skip it and report the outage once in the spawn's summary
  - Start it on the session's own harness

Format (agent's choice): one table at the repository root, beside
`REVIEW.md`, with columns `Work | Harness | Model | Effort`. `Work` is a
size, `XS` to `XL`, or `Review`. A `Review` row's harness is the reviewer's
own: `Review | claude | ...` reviews Codex's work. Prose around the table
is free, so the file can explain its choices. `quest check` reports an
unknown harness or work, a duplicate row, and a model or effort that is not
a plain word (the rule `codexFlags` in `src/cli/agent.ts` already applies).
It does not check that a CLI accepts the model.

This repository's file maps XS Codex `gpt-6.1-sol` high, S Codex
`gpt-6.1-sol` xhigh, M Claude `claude-opus-5-5` medium, L Claude
`claude-opus-5-5` high, XL Claude `claude-opus-5-5` xhigh, and lists the
review rows with the current pins (Claude `claude-opus-5-5` high, Codex
`gpt-6.1-sol` xhigh), so the whole policy reads in one place.

- `quest unblocked` reads `MODELS.md` from the same upstream tree it ranks.
  `quest review` reads it from the base branch's tip, as it does
  `REVIEW.md`, so a PR cannot pick its own reviewer.
- `/quest-spawn`: start a quest whose harness matches the session's as a
  native sub-agent with the mapped model and effort, and one on the other
  vendor through `quest agent` on the logged-in account. An unmapped quest
  inherits the session's settings. Skip a quest whose harness cannot run
  (`quest agent` fails to start it, or exits on a usage limit) and report
  that harness's outage once, with the quests it held back.
- Docs: the README documents `MODELS.md`, `quest unblocked --json`'s new
  fields, and the review rows. The
  [review harness check](/quest/m1/review-harness.md) also compares this
  repository's `MODELS.md` review rows with the pins, and the next run's
  quest carries that forward.

## Required

- [Headless agents](/quest/m0/helpers/headless-agents.md) - `quest agent` runs on the logged-in account, so a session can start the other vendor's agents

## Related

- [Reviewer usage limits](/quest/m0/review-quota.md) - its usage-limit exit is how `quest agent` reports a harness at its limit
