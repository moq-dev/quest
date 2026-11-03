# [XS] Recorded decisions mark the rejected options

## Goal

The grill and plan skills record each decision with the chosen option
marked and the rejected options labelled as rejected, such as
`✅ Yes, as stated (rejected: without the overlap check; drop it)`, so no
reader takes a rejected option for a qualifier of the chosen one.

## Plan

Decided 2026-11-02 (user, /quest-spawn follow-ups): ✅ plan as stated
(rejected: drop it); ✅ m0 (rejected: m1, m2).

- Raised by [moq-dev/quest#416](https://github.com/moq-dev/quest/pull/416):
  Codex read "✅ Yes, as stated; without the overlap check; drop it" as
  dropping the overlap check, and the agent spent a review round refuting
  it.
- Change the recording instruction in `assets/skills/grill.md` and
  `assets/skills/plan.md`. Existing records stay as written.
