---
description: Start work on a quest.
guide: Model, Format, Creation, Execution, Summaries, Questions
---

Your goal is to implement the quest, or as much of it as possible, and open a PR.
The argument is the quest to work on.

If you are unsure on the best course of action, ask the user for direction.

Confirm you can write in your worktree; if you cannot, stop and report without claiming.
Update your checkout and check the forge for an open PR already doing the quest's work, then claim the quest with `quest start <quest>`.
If it refuses, the quest is blocked or someone else holds it: report what it printed and stop.
If it warns that the quest's local branch already exists, the claim succeeded: resume that earlier attempt as the guide describes.
If you cannot pursue a claim before pushing work, release it with `quest start --release <quest>` and remove your isolated worktree; once work is pushed, hand it back as the guide describes.

Implement the quest until it is complete, or some blocker is hit, then push to its PR and update the description.

When done, explain the result in a few lines and summarize any issues encountered.
List choices you made without asking in the PR body rather than waiting on them.

If the quest is complete and you see no decision left for the maintainer beyond its follow-ups', run `/quest-review` on it right away.
Otherwise, prompt the user interactively for each open decision, including your recommendation, and record the outcome as a PR comment as a paper-trail.
Once the quest is complete and the PR reflects the user's answers, run `/quest-review` on it.

A background agent that cannot prompt lists its open decisions in its report instead, running `/quest-review` only when the quest is complete and no decision is left for the maintainer beyond its follow-ups'.
