# [S] Place new quests by rule instead of asking

## Goal

`/quest-plan` places each new quest in the milestone a recorded rule or its
siblings' placement gives: a milestone rule the maintainer stated, in this
session or recorded in the tree, or the milestone of the epic or quests it
joins. It records the placement and the reason in the quest's Plan, lists
it in the summary, and asks only when neither covers the quest.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan,
[the epic](/quest/m0/ask-less/README.md)): ✅ milestone placement stops
being asked; which follow-ups to plan is still asked (rejected: also plan
every recommended follow-up unasked; keep asking both).

Milestone placement was asked 902 times from 2026-10-20 to 11-13, 85% taken
as recommended. `assets/skills/plan.md` asks it of every new quest today,
unless a rule from the same session covers it.
