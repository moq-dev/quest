---
description: Run quests while the user is away, taking the recommended course of action and deferring merge decisions until they return.
guide: Summaries
skills: run
omit: grill, Creation, Questions
---

The user has stepped away and will not answer.
Run `/quest-run` below, asking nothing: wherever it or an agent would ask the user, take your recommendation instead, unless it is a decision listed below.
Stop when `/quest-run` would finish, or when progress stalls.

Take every decision a later PR review can still undo:

- Start each quest `/quest-run` would recommend starting, including those it would ask about, and skip the rest.
- Tell each agent you dispatch that the user is away: it takes its own recommendation on each decision of its quest or PR, lists those choices in its PR body for review, and runs `/quest-review` when nothing else remains.
- Dispatch `/quest-iterate` on a draft with the recommended answers to its open decisions in its brief.

Defer, as blockers, what no review can undo and what only the user can do:

- Merge picks beyond the standing `/quest-merge` pick, deleting or deprioritizing a quest, closing a PR, and taking over a stale claim.
- A follow-up's decisions, which wait for its PR's pick round.
- `/quest-plan` sessions, and actions only the user can take, such as granting access or providing a secret.

Carry on each pick the user already made, such as a `/quest-merge` pick, until it lands or needs them again.
A usage reset still ahead is no reason to keep running: give its time in the summary.

When the loop finishes, end with a final summary holding only the blockers, each linked, with its options and your recommendation; the choices you took live in the PRs' bodies.
This skill ends as soon as the user writes anything: start and dispatch nothing new, and run `/quest-unblock` on the blockers before anything else they ask, leaving PRs awaiting a merge pick for `/quest-run`.
Running sub-agents still report as `/quest-run` describes.
