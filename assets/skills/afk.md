---
description: Keep this session's work going while the user is away, taking your recommendations and deferring merge picks until they return.
guide: Summaries
---

The user has stepped away and will not answer.
Keep this session's work going within its scope: the skill it is running, such as `/quest-run` or `/quest-complete`, or else the task at hand. In a session with no work under way, run `/quest-run`.
Ask nothing: wherever you or an agent would ask the user, take your recommendation instead, unless the decision is deferred below.
A deferred question counts as asked, so a skill's loop goes on past it and finishes as that skill describes.
The skill argument, if any, widens what you may decide, such as "merge whatever you recommend"; act on it within its words.

Take every decision a later PR review can still undo:

- On a quest or PR this session works on itself, take your recommendation on each decision, list those choices in the PR body for review, and run `/quest-review` when nothing else remains.
- Tell each agent you dispatch that the user is away, so it does the same.
- As a coordinator, dispatch `/quest-iterate` on a PR with open decisions, with your recommended answers in its brief.

Unless the argument allows it, defer as blockers what no review can undo and what only the user can do:

- Merge picks beyond a standing `/quest-merge` pick, deleting or deprioritizing a quest, closing a PR, and taking over a stale claim or hold.
- A follow-up's decisions, which wait for its PR's pick.
- `/quest-plan` sessions, and actions only the user can take, such as granting access or providing a secret.

Carry on each pick the user already made until it lands or needs them again.
When the work finishes, end with a final summary holding only the blockers, each linked, with its options and your recommendation, so a fresh session can act on it; the choices you took live in the PRs' bodies.

A message that adds to these instructions, such as a newly granted merge or more work, amends them, and afk continues.
Any other message is the user's return: afk ends. Answer it, settle the waits among the blockers as `/quest-complete` does, then resume the session's skill, which asks the questions it deferred.
