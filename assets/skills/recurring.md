---
description: Plan a quest that repeats, such as a periodic audit or a release cut. Use when the user invokes /quest-recurring or wants the same work redone each milestone or release.
skills: plan
---

Run the plan interview for a quest that recurs: the PR that finishes one run creates the next.
The argument (if provided) is the work to repeat, or an existing quest to make recurring.

Agents working the quest never load this skill, so its Plan says, in its own words, where the next run goes and what gates it.
The next run keeps the Goal and recurrence, and its Plan carries forward what this run learned (baselines, results, what to check first).

Also settle in the interview:

- Where the next run goes. If milestones only grow, it's the same path in the next milestone (`m1/perf/audit.md` to `m2/perf/audit.md`), created with any missing milestone or epic. If they shift up after a release, it's wherever the next run belongs after the shift.
- What gates it. Placement doesn't delay a quest: one with no `Required` is ready at once. Gate it on another recurring quest (such as a release cut) or a condition quest. A quest can't require its own milestone, so to run at the end of mN, the gate requires mN and the next run requires the gate.
- What each run delivers, and whether anything ends the recurrence.

A recurring gate's Plan also says to remove its path from every `Required` before re-creating it, or its dependents never clear.
Findings that need their own work are follow-ups for `/quest-plan`.
