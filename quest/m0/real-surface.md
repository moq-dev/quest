# [S] Passing checks is not verification

## Goal

`quest context` tells every agent that a change's checks passing does not
show it works: before review, the agent exercises the changed behavior on
its real surface, such as the built binary, the running app, or the
endpoint, and reports what it ran and what it saw. The rule is prose;
nothing new is checked.

## Plan

Decided 2026-11-09 (user, /quest-plan, from a comparison with
[pstack](https://github.com/cursor/plugins/tree/main/pstack)'s "Prove It
Works" principle and a scan of the maintainer's typed messages):

- How strongly is it enforced?
  - ✅ Prose only: one rule in `quest context` (user)
  - Rejected: a checked record, where `quest ready` refuses a PR whose
    `## Validation` names no run on the real surface (the agent's
    recommendation)
  - Rejected: a reviewer finding only
- Which milestone? ✅ m0 (rejected: m1)

Why: reviewers run nothing by design, and a PR body's `## Validation`
usually says only that the checks passed. Since 2026-11-06, 65 of 416
merged moq-dev/moq PRs and 14 of 80 merged moq-dev/quest PRs carry
"Caused by" in the body (a phrase search, so approximate). In the typed
messages from 2026-10-26 to 2026-11-10, seven asked an agent to run or
look at what it had built.

Guidance:

- moq-dev/moq.pro's root `AGENTS.md` carries the only copy today, tied to
  its own commands. Word the shared rule for any repository, beside
  "Reproduce bugs before fixing them", and say where the result goes: the
  PR body's validation. A repository's own instructions name its surfaces.
- `assets/CONTEXT.md` is at 9,676 of the 10,000 characters `CONTEXT_LIMIT`
  allows (`src/cli/hooks.ts`), so make room in the same PR if the rule does
  not fit, and follow `quest guide prompting`.
- A change with no behavior to exercise, such as one to `quest/` or docs,
  says so instead.
- The [mistake audit](/quest/m0/mistake-audit.md) measures whether the rule
  held, and proposes a check if it did not.

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - re-measures the fix PRs and
  the typed messages this rule should reduce
