# Cut agent token waste

## Goal

Quest sessions spend their tokens on the work itself, not on loading rules,
a second review pass, polling, oversized coordinator context, or merge churn.
Rules a program can check are enforced instead of read. The epic finishes by
re-measuring the baseline below with `quest usage` and token-max over a
week of sessions and recording the comparison in its closing PR.

Non-goal: the online reviewers (CodeRabbit and Pullfrog are free and stay).

## Plan

Decided 2026-11-05 (user, /quest-plan), from an audit of this host's Claude
Code and Codex transcripts and the moq-dev PRs created 2026-10-06 to 11-05.

Baseline:

- Claude Code, 2026-10-28 to 11-05 (all the data the profile holds): about
  $11k API-equivalent. Re-sent cache is 71% of weighted cost; the average
  request carries 144k tokens of context; the 88 sessions that peaked above
  400k (2.6%) are 35% of cost. Auto-compaction ran 14 times, at a median of
  967k. By skill: iterate 24%, start 24%, complete 22%, spawn 10%.
- Codex, 30 days: 31.0B input tokens, 97% cached. `quest review` is 10% of
  it (28% since 11-02); interactive sessions are 76%. The weekly limit ran
  out on 11-02.
- PRs, 30 days, 7 repositories: 5,553 PRs, 93% merged. Base merges are 33%
  of all commits (70% in moq.pro) and rose from 2.6 to 3.4 per merged PR
  after 11-01. The merge queue ejected 723 PRs for conflicts. 21% of PRs
  change only `quest/*.md`.

Decision prompts, chosen options marked ✅:

- Milestone: ✅ m0 (rejected: m1).
- Online reviewers: ✅ keep CodeRabbit and Pullfrog, which are free
  (rejected: drop them).
- Rules to hooks or lint: first not planned, then ✅ planned the same day
  (user, adopting practices from the research below).
- Adopted 2026-11-05 (user) from a survey of AI-heavy developers' setups
  (Theo's tstack, jdx's jouet, Matt Pocock's skills, HumanLayer, Mitchell
  Hashimoto), chosen ✅ and rejected listed:
  - ✅ Mechanical rules become hooks or lint, so their prose leaves the
    always-loaded rules, done in
    [moq-dev/quest#553](https://github.com/moq-dev/quest/pull/553).
  - ✅ A review round budget by severity, after Theo's `sol-loop`
    ([moq-dev/quest#514](https://github.com/moq-dev/quest/pull/514)).
  - ✅ `quest usage` moves from m1 into this epic, so its closing
    re-measure is one command instead of a multi-agent audit (this audit took
    four agents about 650k tokens). Try jdx's `jouet audit` first and say why
    `quest usage` still earns its place.
  - ✅ Codex compacts at 240k, half its window, in the maintainer's dotfiles
    (outside this tree).
  - Rejected: `disable-model-invocation` on user-only skills (Claude-only,
    small payoff); Ralph loops (greenfield only); the superpowers suite
    (overlaps quest); octopool (heavy to run); a test-runner sub-agent
    (large tool outputs were not a measured cost); evals for skill text
    (later).
- Applied outside the tree the same day: Claude's auto-compact window is
  400k for Opus (`modelSettings.claude-opus-5-5.autoCompactWindow`, the
  value the Claude Code team recommends), and `BASH_MAX_TIMEOUT_MS` is
  3300000, just under the 1h prompt-cache TTL, in the maintainer's user
  settings. The 1h TTL stays for main sessions and sub-agents: replayed over
  the requests since 10-30, a 5m TTL would have cost 35% more cache spend
  for main sessions and 14% more for sub-agents.
- The milestone re-cut the maintainer raised (m1 additive improvements, m2
  semver-breaking features) is moq-dev/moq's own plan: ✅ re-plan moq
  separately (rejected: make it quest's convention; not now).
