# Route quests to models by size

## Goal

`/quest-spawn` starts each ready quest on the first harness and model that
can run from a ranked list `quest` builds in for the quest's size, the same
for every repository unless its `AGENTS.md` overrides it: Grok for XS, Opus
from S up, with Sol as the fallback through M, and a usage limit falling
through to the next entry. Sol reviews, at an effort set by size, and Opus
reviews whatever Sol wrote, so no model reviews its own code. Every commit
and PR records the models and efforts behind it, and fixes link the PR that
caused them, so the rankings can be audited and retuned. This epic's own
work is one live spawn in moq-dev/quest from Claude Code that starts an XS
quest on Grok and an S or larger on Opus, each recorded and reviewed by Sol.

Non-goals: routing kix.quest's runner jobs, which pick their own accounts
and models (their commits still record their models); billing agents to API
keys, which this epic removes.

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
  to the next entry (user), and a quest with an open maintainer decision
  routes one size up.
- The lists, settled later the same day (user), replacing earlier ones that
  led S with Sol, ranked Grok and DeepSeek reviewers, and considered free
  models: Opus writes the code, since it does a much better job. XS: Grok
  high, then Sol medium. S: Opus medium, then Sol high. M: Opus high, then
  Sol xhigh. L and XL: Opus xhigh, no fallback. Reviews: Sol low, medium,
  high, xhigh, xhigh for XS to XL, never the model that wrote the code;
  Pullfrog and CodeRabbit add free reviews on top.
- Every commit and PR records its models and efforts, and every fix links
  the PR that caused it, so the rankings can be audited (user).
- Every `/quest-review` scores the change out of 10 (user, while planning
  [the council](/quest/m2/council.md), which joins m2).
- Which milestone? ✅ m0 (rejected: m1). It ranks first among m0's work
  after Kix, by the 2026-11-01 order: land work, then Kix, then the rest.

## Required

- [Grok agents](/quest/m0/model-routing/agent-harnesses.md) - `quest agent` starts Grok as well as Claude Code and Codex
- [Route by size](/quest/m0/model-routing/models.md) - `/quest-spawn` starts each quest on the first entry of its size's ranked list that can run
- [Review by size](/quest/m0/model-routing/review-effort.md) - Sol reviews at an effort set by size, and Opus reviews what Sol wrote
- [Commits and PRs record their models](/quest/m0/model-routing/implementer.md) - commit trailers and PR records name each harness, model, and effort, and the PR's size
- [Fixes link their culprits](/quest/m0/model-routing/culprits.md) - a fix lists the PR that introduced the problem under `## Caused by`
- [moq-dev pins](/quest/m0/model-routing/pins.md) - moq-dev/moq and moq-dev/moq.pro bump their `quest` pin to pick up the routing
