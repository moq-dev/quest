# Route quests to models by size

## Goal

`/quest-spawn` starts each ready quest on the first harness and model that
can run from a ranked list `quest` builds in for the quest's size, the same
for every repository unless its `AGENTS.md` overrides it, so cheaper models
take the easy quests, Opus the hard ones, and a usage limit falls through
to the next entry. Reviews rank the same way, from a different maker than
the implementer, and each PR records its size, implementer, and reviewer
so the lists can be retuned from outcomes. This epic's own work is one live
spawn in moq-dev/quest from Claude Code that starts an XS quest on Grok, an
S on Codex, and an M or larger on Claude, each PR recording its size and
implementer and reviewed by a different maker from its size's list.

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
  - ✅ A table built into `quest`, the same for every repository, which a
    repository's `AGENTS.md` overrides in prose (user, later on 2026-11-04,
    replacing the first answer: a `MODELS.md` in each repository)
  - A `MODELS.md` in each repository, parsed by `quest`
  - Per quest, in its plan
  - A per-user config file

  Plans never name models: ids change every few months, and the planner
  cannot know which accounts the spawner has.
- How are small judgment-heavy quests told apart from easy ones?
  - ✅ Fold judgment into size: a size measures the agent's effort,
    judgment included
  - A separate difficulty marker
- The first mapping, since replaced by ranked lists: XS Codex `gpt-6.1-sol` high, S Codex
  `gpt-6.1-sol` xhigh, M Claude `claude-opus-5-5` medium, L Claude
  `claude-opus-5-5` high, XL Claude `claude-opus-5-5` xhigh (user). Codex
  moves up a rung of effort from its default and Opus down one.
- Every PR records the harness, model, and effort that implemented it
  (user).
- Review effort scales with PR size (user, follow-up of
  [moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)): XS and S
  reviews run Codex medium and Claude low, M and sizeless PRs Codex high and
  Claude medium, L and XL Codex xhigh and Claude high. Skills' own PRs, such
  as `/quest-plan`'s, carry a size too.
- moq-dev/moq and moq-dev/moq.pro pick the routing up through a pin bump,
  with nothing else changed in them (user).
- A recurring [model check](/quest/m0/model-check.md) audits the tables
  from the routed PRs, first in m0 once this epic lands, then each
  milestone (user).
- Ranked lists replace one model per size, so a usage limit falls through
  to the next entry (user): Grok for XS, Sol for S, Opus for M and up, and
  a quest with an open maintainer decision routes one size up. Reviews rank
  cheaper models, including Grok and DeepSeek through opencode, from a
  different maker than the implementer. No free models (user).
- Every `/quest-review` scores the change out of 10 (user, while planning
  [the council](/quest/m2/council.md), which joins m2).
- Which milestone? ✅ m0 (rejected: m1). It ranks first among m0's work
  after Kix, by the 2026-11-01 order: land work, then Kix, then the rest.

## Required

- [More agent harnesses](/quest/m0/model-routing/agent-harnesses.md) - `quest agent` starts Grok and opencode as well as Claude Code and Codex
- [Route by size](/quest/m0/model-routing/models.md) - `/quest-spawn` starts each quest on the first entry of its size's ranked list that can run
- [Grok and opencode reviewers](/quest/m0/model-routing/review-harnesses.md) - `quest review` runs them read-only, as it runs Claude Code and Codex
- [Review by size](/quest/m0/model-routing/review-effort.md) - `quest review` picks its reviewer from its size's ranked list, from a different maker than the implementer
- [Review score](/quest/m0/model-routing/review-score.md) - every `quest review` round scores the change out of 10
- [Sizes include judgment](/quest/m0/model-routing/size-judgment.md) - the guide and `/quest-plan` size a quest by the agent's effort, judgment included
- [PRs record their implementer](/quest/m0/model-routing/implementer.md) - each PR names its size and the harness, model, and effort that wrote it, beside its reviewer's
- [moq-dev pins](/quest/m0/model-routing/pins.md) - moq-dev/moq and moq-dev/moq.pro bump their `quest` pin to pick up the routing
