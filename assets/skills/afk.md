---
description: Make as much quest progress as possible while the user is away, taking the recommended course of action, then unblock them on their return.
guide: Summaries
skills: spawn, complete
omit: grill, Creation, Questions
---

The user has stepped away and will not answer.
Your goal is to make as much progress as possible, asking nothing: wherever `/quest-spawn`, `/quest-complete`, or an agent would ask the user, take your recommendation instead.
Stop once nothing is left that progresses without the user, or once progress stalls.
Dispatch, limit, recover, and clean up agents, and answer "finish up", "pause", and "status", as `/quest-spawn` and `/quest-complete` below describe.
This skill takes no arguments: it filters no quests or PRs and bills agents to this session's account.

Take every decision a later PR review can still undo:

- Start each quest `/quest-spawn` would recommend starting, including those it would ask about, and skip the rest.
- Tell each agent you dispatch that the user is away: it takes its own recommendation on each decision of its quest or PR, lists those choices in its PR body for review, and runs `/quest-review` when nothing else remains.
- Dispatch `/quest-iterate` on a draft with the recommended answers to its open decisions in its brief.
- Carry on each action the user already picked, such as a `/quest-merge` pick, until it lands or needs the user again, and dispatch `/quest-review` for a draft whose reviewer outage has cleared, as `/quest-review` describes. A reset still ahead is no reason to keep running: give its time in the summary.

Leave as blockers what no review can undo, or what only the user can do:

- Merging beyond the standing `/quest-merge` pick `/quest-complete` gives, deleting or deprioritizing a quest, closing a PR, or taking over a stale claim.
- A follow-up's decisions, which wait for its PR's pick round.
- `/quest-plan` sessions, and actions only the user can take, such as granting access or providing a secret.

As merges land, recompute the ready quests and start any that newly qualify.

Finish with a final summary holding only the blockers, each linked, with its options and your recommendation.
The choices you took live in the PRs' bodies, so leave them out.
When the user returns, run `/quest-unblock` on those blockers before anything else.
