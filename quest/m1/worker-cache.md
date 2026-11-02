# [M] Re-plan workers that fit a 5-minute prompt cache

## Goal

A decision, through `/quest-plan`, on whether background workers should do
one burst each within a 5-minute prompt cache while the coordinator runs the
long waits, and on gate tickets. The result is either quests planned
against the current skills or a recorded decision to drop the idea.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [M], m1, as
[moq-dev/quest#276](https://github.com/moq-dev/quest/pull/276)'s decision 2
recommended when it was closed as superseded on 2026-11-01.

- First confirm the premise: that sub-agents really keep only a 5-minute
  prompt cache while the foreground keeps a 1-hour one. If they don't, say
  so and drop the split.
- #276 (head
  [811deae](https://github.com/moq-dev/quest/commit/811deaef7e4550901f0de158217e970e24bc6977))
  had workers do one burst with every tool call under 4 minutes, push only
  to drafts, and terminate, while the coordinator ran full checks,
  `quest review` rounds, and gated commands. Its
  [gate tickets](https://github.com/moq-dev/quest/blob/811deaef7e4550901f0de158217e970e24bc6977/quest/m0/gate-tickets.md)
  quest had `quest gate` return within 4 minutes with a token or a ticket.
  Re-plan both against main's current skills, which already stopped waiting
  on GitHub.
- Include the handoff fix from #276's open review finding: a finished
  worker's draft stays held by its starter, so the coordinator's
  `quest ready` is refused.
