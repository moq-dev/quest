# [M] quest usage counts the online reviewers

## Goal

`quest usage` reports, for each online reviewer on each PR: whether it
reviewed the final head, how many findings it raised, and how many were
fixed, declined, or left unanswered. The online reviewers are CodeRabbit,
Pullfrog, and the Dot, ChatGPT's reviewer that posts as the maintainer.
Rollups per reviewer and repository give coverage, findings per PR, and
acceptance. The data comes from GitHub; the PR body gains nothing.

## Plan

Decided 2026-11-11 (user, /quest-plan,
[routing evidence](/quest/m0/routing-evidence/README.md)): measure the
online reviewers in usage instead of recording them in PR bodies.

How the 2026-11-11 audit identified each, for the implementer to verify:

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
- Classify a reply as accepted or declined from its first word ("Fixed",
  "Agreed", "Applied", or "Declined", "Refuted", "Not"). Count an
  unclassifiable reply as answered.
