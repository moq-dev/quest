# Route quests to models by size

## Goal

`/quest-spawn` starts each ready quest, and each coordinator its
`/quest-iterate` dispatches, on the first harness and model that can run from
a ranked list `quest` builds in for the work's size, the same for every
repository unless its `AGENTS.md` overrides it: Opus writes at every size,
with Sol as the fallback through M, and a usage limit falls through to the
next entry. An iterate is sized by the work left on its PR, not its quest's
original size, and runs on the model that first wrote the PR, so the other
can always review it. Sol reviews, at an effort set by the PR's size, and Opus
reviews whatever Sol wrote, so no model reviews its own code. Every PR
records the models and efforts behind it, and fixes link the PR that
caused them, so the rankings can be audited and retuned. This epic's own
work is one live spawn in moq-dev/quest from Claude Code that starts an XS
and an S quest on Opus, each recorded and reviewed by Sol.

Non-goals: routing kix.quest's runner jobs, which pick their own accounts
and models (their PRs still record their models); billing agents to API
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
- The lists, settled later the same day (user) and revised on 2026-11-05 (below), replacing earlier ones that
  led S with Sol, ranked Grok and DeepSeek reviewers, and considered free
  models: Opus writes the code, since it does a much better job. XS: Grok
  high, then Sol medium. S: Opus medium, then Sol high. M: Opus high, then
  Sol xhigh. L and XL: Opus xhigh, no fallback. Reviews: Sol low, medium,
  high, xhigh, xhigh for XS to XL, never the model that wrote the code;
  Pullfrog and CodeRabbit add free reviews on top.
- Every PR records its models and efforts, and every fix links the PR that
  caused it, so the rankings can be audited (user). The PR record alone,
  without commit trailers (user, 2026-11-04 design checkpoint of
  [moq-dev/quest#494](https://github.com/moq-dev/quest/pull/494), revising
  that day's /quest-plan pick of `Agent-*` trailers): squash merges drop
  branch trailers from `main`, so audits read the PR record anyway.
- Every `/quest-review` scores the change out of 10 (user, while planning
  [the council](/quest/m2/council.md), which joins m2).
- Revised 2026-11-05 (user, /quest-plan): Grok leaves routing and the
  council, so XS starts on Opus low; Sol reviews at the effort it would
  write at (XS medium, S high, M xhigh, L and XL xhigh); and coordinators
  size each `/quest-iterate` by its remaining work. The tables and the
  iterate decisions are in [Route by size](/quest/m0/model-routing/models.md).
- Revised again 2026-11-05 evening (user, /quest-plan): xhigh is XL's
  alone. Haiku high writes XS; Opus writes S low, M medium, L high, XL
  xhigh; Sol falls back one rung lower, now through L; Sol reviews follow
  [Single-pass review](/quest/m0/token-waste/review-single-pass.md)'s
  table. The tables and the benchmark evidence are in
  [Route by size](/quest/m0/model-routing/models.md).
- Which milestone? ✅ m0 (rejected: m1). It ranks first among m0's work
  after Kix, by the 2026-11-01 order: land work, then Kix, then the rest.

## Required

- [Route by size](/quest/m0/model-routing/models.md) - `/quest-spawn` and iterate dispatches start on the first entry of the size's ranked list that can run, an iterate sized by its remaining work
- [kix records its follow-up sessions](/quest/m0/model-routing/kix-sessions.md) - kix `iterate` and `merge` jobs that change an existing PR record their `Implementer:` line in a PR comment
- [moq-dev pins](/quest/m0/model-routing/pins.md) - moq-dev/moq and moq-dev/moq.pro bump their `quest` pin to pick up the routing
