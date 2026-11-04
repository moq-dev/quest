# [XS] Decision records that last and mark the rejected options

## Goal

The grill and plan skills record each decision with the chosen option
marked and the rejected options labelled as rejected, such as
`✅ Yes, as stated (rejected: without the overlap check; drop it)`, so no
reader takes a rejected option for a qualifier of the chosen one.

Each record also outlives its quest: a decision goes in the quest's Plan,
or in the PR body's `## Decisions` when that PR deletes the quest, since the
deletion would take the Plan's record with it.

## Plan

Decided 2026-11-02 (user, /quest-spawn follow-ups): ✅ plan as stated
(rejected: drop it); ✅ m0 (rejected: m1, m2).

- Raised by [moq-dev/quest#416](https://github.com/moq-dev/quest/pull/416):
  Codex read "✅ Yes, as stated; without the overlap check; drop it" as
  dropping the overlap check, and the agent spent a review round refuting
  it.
- Change the recording instruction in `assets/skills/grill.md` and
  `assets/skills/plan.md`. Existing records stay as written.

Decided 2026-11-03 (maintainer, /quest-complete on moq-dev/moq, planned
through moq-dev/moq's coordinator): fold where decisions are recorded into
this quest, since it changes the same recording instructions. It stays in
m0 at its rank.

- `assets/skills/plan.md` says to record each settled decision "in the
  quest's Plan", and `assets/skills/unblock.md` records an answer in the
  quest's Plan and then deletes a quest whose only purpose was the wait.
  A PR that finishes a quest deletes its file, so a decision made in that
  PR has no Plan to live in.
- Suggested wording: "record it in the quest Plan, or in the PR's Decisions
  if the PR deletes the quest." Apply it in `plan.md` and `unblock.md`, and
  wherever else the guide or a skill sends decisions to a quest's Plan.
  `assets/skills/iterate.md` already records decisions in the PR's
  description; name the same `## Decisions` section there.
