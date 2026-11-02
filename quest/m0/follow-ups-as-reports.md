# [S] Plan follow-ups as agents report

## Goal

`/quest-complete` and `/quest-spawn` plan each agent's suggested follow-ups
in the foreground as its report arrives, whenever no question is pending,
while the other agents keep running. Agents suggest only follow-ups worth a
quest, and a milestone rule the maintainer states once, such as "CI and
flakes join m0", holds for the rest of the session instead of being asked
per quest.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from a scan of
the maintainer's Claude Code and Codex transcripts since 2026-10-12):

- Is that the goal? ✅ Yes, as stated; only plan as reports arrive; drop it.
- Which milestone? ✅ m0, after the land work and before Kix; m0 last; m1.

Evidence from the scan:

- The maintainer asked for follow-ups early 21 times in 14 sessions ("plan
  any follow-ups now, leave agents running", 2026-10-29; "follow-ups now
  please", 2026-10-31). A coordinator answered "I'll run that interview once
  the merge agents report", and the maintainer had to ask "do that now?".
- One handback carried about 178 follow-ups and led to 157 questions, 96 of
  them milestone picks answered with the recommendation, until the
  maintainer gave standing rules ("use recommended for any CI/flakes",
  "anything you recommend for m2/m3 quests"). Batching every follow-up into
  one question was refused too ("one at a time please", 3 sessions).

Files: `assets/skills/complete.md` and `assets/skills/spawn.md` (both plan
"once every sub-agent has finished"), `assets/skills/plan.md`, and the
guide's Creation section in `assets/AGENTS.md`.

- Plan as reports arrive, one follow-up per `/quest-plan` run as now, but
  never ahead of a pending pick or decision question.
- The guide tells agents to suggest a follow-up only when it is worth a
  quest, and to drop "optional" or "only if it matters" ones.
- plan.md applies a milestone rule the maintainer states for the session
  without asking again, and still shows the milestone it picked.

## Related

- [Kix decision UI](/quest/m0/kix/README.md) - kix turns each job's
  follow-ups into a "plan these?" decision; this is the local skills' side
