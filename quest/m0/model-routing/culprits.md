# [S] Fixes link the PR that caused them

## Goal

A PR that fixes a bug, or redoes work an earlier PR did not do properly,
lists that earlier PR under a `## Caused by` section in its body, with one
line on what it got wrong. GitHub's cross-reference then shows the fix on
the earlier PR's timeline, and the [model check](/quest/m1/model-check.md)
and [`quest usage`](/quest/m1/usage.md) count culprits against each
original PR's size, implementer, and reviewer, to judge whether it should
have run on a stronger model or effort.

## Plan

Decided 2026-11-04 (user, /quest-plan follow-ups of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)): link any PR
that introduced a bug or was not done properly, so audits have backlinks.

- `quest context`'s Pull requests section adds the rule: before opening a
  fix, find the PR that introduced the problem, from `git log` and
  `git blame` on the lines the fix changes to the commit that added them,
  and from that commit to its PR. List each under `## Caused by` as
  `- [owner/repo#N](url) - what it got wrong`. When no single PR caused
  it, such as an upstream change or a bug as old as the code, say so in
  one line instead of leaving the section out.
- `/quest-plan` carries a known culprit into a fix quest's Plan, so the
  agent that implements the quest lists it without searching again.
- Review findings fixed in the same PR are not culprits: the record is
  for problems that reached the base branch.
- `quest usage` and the model check read the section; this quest only
  writes it.
