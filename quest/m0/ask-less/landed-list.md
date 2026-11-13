# [M] List what landed on a standing pick

## Goal

The maintainer sees, in one list across their repositories, every PR that
merged on a standing pick since they last looked, grouped by the class it
qualified under, one line each. Naming one starts its revert or its redo,
as the maintainer says, as a new PR. The
[decisions session](/quest/m0/ask-less/decisions-session.md) shows the
list first.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan,
[the epic](/quest/m0/ask-less/README.md)): ✅ a landed list the maintainer
acts on (rejected: session summaries only; the list plus a weekly
second-model audit of a sample).

Agent's choices, for the implementer to revisit:

- A CLI command reading the [recorded picks](/quest/m0/ask-less/recorded-picks.md)
  of merged PRs, with `--since` and `--json`, so the skill step stays
  prose-light.
- "Since they last looked" is the time the list was last shown, kept in the
  user's own state, never in a repository.

## Required

- [Recorded picks](/quest/m0/ask-less/recorded-picks.md) - which PRs merged
  on a standing pick, and under which class
