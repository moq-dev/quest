# [M] Chart cost against quality for every model and effort

## Goal

Each [model check](/quest/m1/model-check.md) run, and this epic's
readout, publishes charts of cost against quality for every writer and
reviewer model and effort `quest` runs, and links them in its PR, so a
routing change is read off the cost/quality frontier rather than tables:

- Writers: cost per merged PR against first-round findings, review rounds,
  hand-backs, and later `## Caused by` escapes, one point per size, model,
  and effort.
- Reviewers: cost per review against findings raised and the share fixed or
  accepted, for the local reviewers and the online ones, which `quest usage`
  reports since [moq-dev/quest#642](https://github.com/moq-dev/quest/pull/642).
- Beside our points, the published benchmark points for the same models and
  efforts, so a cell where our work departs from the benchmarks stands out.

Non-goal: a live dashboard. No chart code ships in `quest`.

## Plan

Decided 2026-11-11 (user, /quest-plan in a /quest-run session, when picking
[moq-dev/quest#642](https://github.com/moq-dev/quest/pull/642) to merge):

- Goal? ✅ Charts for the model check and the readout, the two places
  routing changes (rejected: a live dashboard; benchmarks only)
- Which data? ✅ Our measured points from `quest usage --json` with published
  benchmark points beside them (rejected: ours only; benchmarks only)
- Where do they live? ✅ An artifact per run: the agent running the check or
  the readout renders a private claude.ai page from `quest usage --json` and
  the benchmark table, and links it in its PR, so the core stays
  independent of a harness (rejected: a `quest usage --html` report, which
  adds chart code and tests to the CLI; token-max, which knows no PR
  quality signals)
- Milestone? ✅ m0, in this epic (rejected: m1)

The benchmarks behind the XS writer change, for the first table
([writer A/B](/quest/m0/routing-evidence/writer-ab.md) records the decision):

- Anthropic's
  [cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence),
  SWE-bench Pro subset: Opus 5.5 low 87.4% and medium 92.8%, Sonnet 5.5
  high 87.6% with medium about 7 points lower, at about $0.11 per solved
  task for Opus low and Sonnet high.
- [Artificial Analysis](https://artificialanalysis.ai/models/comparisons/claude-sonnet-5-5-high-vs-claude-opus-5-5-low),
  Terminal-Bench 4.0 and cost per task: Opus 5.5 low 31.3%, $0.98; Sonnet
  5.5 high 43.9%, $1.64; Sonnet 5.5 medium 29.8%, $0.78; Haiku 5.5 xhigh
  29.3%, $0.25.

Agent's choices, for the implementer to revisit:

- Keep the benchmark points as a table in the model check's Plan, where its
  existing benchmark notes already live, with each row's source, effort, and
  date; each run refreshes it. A row without a stated effort stays out.
- Write the chart procedure into the model check's Plan and the epic's
  readout: which `quest usage --json` fields feed each axis, how cells with
  too few PRs are marked rather than dropped, and that each chart names its
  date range and PR counts.
- Make the first charts from the data on main when this lands, link them in
  this quest's PR, and say which cells are still too thin.

## Required

- [Review tallies](/quest/m0/routing-evidence/review-tallies.md) - the
  findings each reviewer raised across rounds
- [usage through token-max](/quest/m0/routing-evidence/usage-token-max.md) -
  the cost axis, which today misses sub-agent transcripts, 72% of host spend
