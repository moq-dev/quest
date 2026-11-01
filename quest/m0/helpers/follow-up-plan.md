# [XS] Plan a delegated merge's follow-ups

## Goal

A caller that receives a merged PR's suggested follow-ups from a sub-agent,
such as a background `/quest-merge`, runs `/quest-plan` on them without
asking first, and its interview lets the user drop any. One rule in the
guide says this, replacing the copies in `complete.md` and `spawn.md`.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)).

- [moq-dev/quest#266](https://github.com/moq-dev/quest/pull/266) made a
  foreground `/quest-merge`, `/quest-complete`, and `/quest-spawn` plan
  follow-ups without asking. A single `/quest-merge` run as a background
  agent only lists them in its report, and no rule told the caller to plan
  them: #271's follow-ups waited for the user to ask.
- The rule belongs in the guide, beside "A suggested follow-up becomes a quest
  only through `/quest-plan`", so it covers any skill that delegates a merge.
  `complete.md` and `spawn.md` keep only what is specific to them, such as
  waiting until every sub-agent has finished.
- `/quest-afk` still holds follow-ups for the user, since it runs no
  interview.
- Also update the guide's "`/quest-merge` decides which to plan", which
  predates #266.
