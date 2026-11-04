# Route quests to models by size

## Goal

`/quest-spawn` starts each ready quest on the harness, model, and effort
that the repository's `MODELS.md` gives the quest's size, so Codex takes
the easy quests and Claude the hard ones, and each PR records which model
did the work so the table can be retuned from outcomes. This epic's own
work is one live mixed-vendor spawn: in moq-dev/quest, with this
repository's `MODELS.md`, a `/quest-spawn` from Claude Code starts at least
one XS or S quest on Codex and one M or larger on Claude, each PR records
its implementer, and each is reviewed by the other vendor.

Non-goals: kix.quest's runner jobs, which pick their own accounts and
models; billing agents to API keys, which this epic removes.

## Plan

Decided 2026-11-04 (user, /quest-plan), from this evidence: across 202
finished quests, landed lines (median / p75 / p90) were XS 58 / 142 / 318,
S 215 / 342 / 551, M 654 / 1070 / 1651, L 732 / 2063 / 4585, and mean
`quest review` rounds were XS 1.3, S 1.6, M 2.1, L 3.7 (47 PRs that
recorded rounds). Size orders the work but the ranges overlap widely, and
some 24 to 31 line skill and guide rewordings were sized M because they
are mostly judgment.

- Where does each quest's model come from?
  - ✅ A `MODELS.md` in the repository, by size; a size it does not map
    starts on the spawning session's own harness, model, and effort
  - A pinned table in quest's code
  - Per quest, in its plan
  - A per-user config file

  Plans never name models: ids change every few months, and the planner
  cannot know which accounts the spawner has.
- How are small judgment-heavy quests told apart from easy ones?
  - ✅ Fold judgment into size: a size measures the agent's effort,
    judgment included
  - A separate difficulty marker
- This repository's mapping: XS Codex `gpt-6.1-sol` high, S Codex
  `gpt-6.1-sol` xhigh, M Claude `claude-opus-5-5` medium, L Claude
  `claude-opus-5-5` high, XL Claude `claude-opus-5-5` xhigh (user). Codex
  moves up a rung of effort from its default and Opus down one.
- Every PR records the harness, model, and effort that implemented it
  (user).
- Which milestone? ✅ m0 (rejected: m1). It ranks first among m0's work
  after Kix, by the 2026-11-01 order: land work, then Kix, then the rest.

## Required

- [Route by MODELS.md](/quest/m0/model-routing/models.md) - `/quest-spawn` starts each quest on the harness, model, and effort `MODELS.md` maps its size to, and `quest review` takes its reviewers from it
- [Sizes include judgment](/quest/m0/model-routing/size-judgment.md) - the guide and `/quest-plan` size a quest by the agent's effort, judgment included
- [PRs record their implementer](/quest/m0/model-routing/implementer.md) - each quest PR names the harness, model, and effort that wrote it
