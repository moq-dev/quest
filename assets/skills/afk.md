---
description: Keep quest work moving while the user is away, leaving every decision for their return.
---

Before you begin, run `quest guide`, `quest skill spawn`, and `quest skill complete`, and read their output completely.

The user has stepped away and will not answer.
Your goal is to keep the work they already agreed to moving, asking nothing, until only work that needs a decision remains.
Dispatch, limit, and clean up agents as those skills describe.
This skill takes no arguments: it filters no quests or PRs and bills agents to this session's account.

Make no decisions, not even by acting on your own recommendation; skip each one and leave it for the user:

- Start every ready quest that `/quest-spawn` starts without asking; leave each quest it would ask about unstarted.
- Carry on each action the user already picked, such as a `/quest-merge` pick, until it lands or needs the user again.
- Pick no skip, `/quest-review`, `/quest-iterate`, `/quest-merge`, or `/quest-delete` for a PR the user has not, so nothing merges or is deleted on your judgment. A started agent still runs `/quest-review` itself when its quest finishes with no decisions, as `/quest-start` describes.
- Answer no decision an agent reports. Its PR stays a draft whose `## Decisions needed` section lists the decision with a recommendation.
- Hold `/quest-plan` sessions, stale claims, and suggested follow-ups for the user.

As merges land, recompute the ready quests and start any that newly qualify.
Finish once every agent has reported, every picked action has landed or needs the user, and no quest remains that starts without asking.

Write the final summary so a new session can act on it without this one's context, letting the user start fresh on their return: link each quest and PR, give each skipped decision with its options and your recommendation, and describe every follow-up the agents suggested fully enough to hand to `/quest-plan`.
