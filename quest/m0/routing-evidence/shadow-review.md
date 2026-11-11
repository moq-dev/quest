# [M] A shadow reviewer one effort below the routed one

## Goal

On every PR, `quest review` also runs the routed reviewer's model one effort
below the routed effort, on the same head and in its own session, beside
the size's reviewer and DeepSeek. Its findings are settled like any
finding. The `## Review` record and `quest usage` mark it as the shadow, so
the readout can compare each effort step against the one below it.

## Plan

Decided 2026-11-11 (user, /quest-plan,
[routing evidence](/quest/m0/routing-evidence/README.md)):

- Which effort does the shadow run?
  - ✅ One step below the routed efforts in `src/cli/models.ts` (Sol medium,
    medium, high, xhigh, and xhigh for XS to XL): Sol low, low, medium, high,
    high for XS to XL
  - Rejected: a random step down or up; always one step up; always the
    efforts before 2026-11-11
- How often, and what happens to its findings?
  - ✅ Every PR, settled like any finding, so each has a disposition. It
    reruns only while it has findings to settle.
  - Rejected: every PR with findings only recorded; a random 25%

Agent's choices, for the implementer to revisit:

- The shadow runs the routed reviewer's model, so when Opus reviews Sol's
  code, the shadow is Opus one step down. It is skipped where no lower
  effort exists, such as Opus low.
- The readout compares per-PR finding counts in pairs. A shadow finding
  that matches a routed finding on the same file, within a few lines, counts
  as found by both. The implementer checks a sample of matches by hand
  before trusting the rule.

## Required

- [Review tallies](/quest/m0/routing-evidence/review-tallies.md) - counts the
  shadow's findings across rounds
