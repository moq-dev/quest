# [M] quest usage counts the online reviewers

## Goal

`quest usage` reports, for each online reviewer on each PR: whether it
reviewed the final head, how many findings it raised, and how many were
accepted, declined, or left unanswered. A reviewer is any bot account that
posts reviews, plus any review whose body opens with
`Automated review by <name>`, such as the Dot, ChatGPT's reviewer that
posts as the maintainer. Rollups per reviewer and repository give coverage,
findings per PR, and acceptance. The data comes from GitHub; the PR body
gains nothing, and no reviewer is named in the code.

## Plan

Decided 2026-11-11 (user, /quest-plan,
[routing evidence](/quest/m0/routing-evidence/README.md)): measure the
online reviewers in usage instead of recording them in PR bodies.

What the 2026-11-11 audit saw of today's reviewers, to check the generic
rules against rather than to code in:

- CodeRabbit (`coderabbitai[bot]`) posts inline threads tagged Major or
  Minor. "✅ Addressed in commit(s)" is its own check. "✅ Confirmed as
  addressed by @kixelated" only echoes the agent's reply. Its summary ends
  in "Review limit reached" when the hourly cap skipped the PR.
- Pullfrog (`pullfrog[bot]`) names its model in each comment's footer
  ("Using `...`"), resolves its own threads on re-review, and posts outage
  comments, such as a rejected OpenRouter key or exhausted credit, that are
  not reviews.
- The Dot posts as the maintainer: a review body that starts with
  "Automated review by review (OpenAI)", with findings as `[P1]`-`[P3]`
  lines in the body rather than threads. A finding counts as settled when a
  later Dot review on the PR no longer lists it. A reply in a thread or
  comment counts as an answer.
- Agent replies post as the maintainer too and end in a `(Written by ...)`
  line, which tells them apart from the Dot.

Agent's choices, for the implementer to revisit:

- Read threads through GraphQL `reviewThreads` in pages, since REST's
  hourly quota is shared and an earlier audit exhausted it.
- A finding is a review thread, or a `[P<n>]` line in a review body, the
  marker Codex's reviewers use. Comments outside reviews, such as outage
  notices, are not findings.
- Classify a reply as accepted or declined from its first word ("Fixed",
  "Agreed", "Applied", or "Declined", "Refuted", "Not"). Report a reply
  that fits neither as a fourth state, answered but unclassified, so the
  rule's misses stay visible.
