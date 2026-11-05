# [L] quest usage reports models, cost, and accuracy

## Goal

`quest usage` reports, from this host's agent session logs and the PRs'
records, which harness, model, and effort worked on each quest and PR and
in which role (implementing, reviewing, iterating, council, land fixer),
with each session's tokens and an API-equal cost estimate, and how the
work went: review scores, rounds, findings, and follow-up fixes. It rolls
the sessions up by size and model, so the maintainer can audit cost and
accuracy, and the [model check](/quest/m1/model-check.md) takes its
tallies from it.

## Plan

Decided 2026-11-04 (user, /quest-plan):

- Which milestone? ✅ m1 (rejected: a new m3, m2). Moved to m0's
  [token waste](/quest/m0/token-waste/README.md) epic on 2026-11-05 (user),
  whose closing re-measure runs it.
- Where is it seen?
  - ✅ A `quest usage` CLI first, working without kix; a kix page can
    follow as its own quest
  - A kix dashboard
  - Both in one quest
- What does cost mean, since subscriptions don't bill per token?
  - ✅ Input, cached, and output tokens per session, plus an estimate at
    each model's API list price, labeled as an estimate
  - Tokens only
  - Each session's share of its plan's usage limit

- Tokens and cost: ✅ reuse [ccusage](https://github.com/ccusage/ccusage)'s
  `session --json` (decided 2026-11-05, user, while planning
  [token-max](/quest/m0/token-waste/token-max.md); rejected: quest's own
  log readers and price table). ccusage already reads Claude Code, Codex,
  opencode, and Grok sessions and prices them from models.dev, so quest
  keeps only what is its own: tying sessions to quests and PRs, and the
  review record.

Agent's choices, for the implementer to revisit:

- A session belongs to a quest or PR by its working directory's checkout
  and branch: a quest branch names its quest, and a PR's head branch names
  the PR. Sessions on no quest or PR branch roll up as unattributed. Check
  that ccusage's session JSON carries a session id or path to join on;
  where it lacks the branch, read only that from the session's log,
  honoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, never printing prompt or
  reply text. Sessions that `quest agent` and `quest review` start are
  found the same way, so nothing new is logged.
- When `ccusage` is not installed, say how to install it and still report
  the review record.
- Accuracy comes from the PR record: the body's `## Models` size and
  implementers, and each `## Review` round's reviewer, score, and findings
  with their dispositions; follow-up fixes are later PRs that list it under
  `## Caused by` (`quest context`'s Pull requests section).
- Output: a table per quest or PR, a rollup by size, role, and model, and
  `--json`. `--since`, `--quest`, and `--pr` narrow it.
- One host only: each host reports its own sessions. Combining hosts
  belongs with the kix page.

## Required

- [Route quests to models by size](/quest/m0/model-routing/README.md) - the PR records of size, implementer, reviewer, and score it reads
