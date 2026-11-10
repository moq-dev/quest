---
description: Start multiple quests in parallel.
guide: Summaries
skills: run
---

Run only the Quests part of `/quest-run` below, with its loop's rounds: start ready quests as agents report, and stop once none is running and none is left to start.
Ask the user nothing: every decision waits in a PR or in the final summary.
Leave every PR to `/quest-run` or `/quest-complete`, beyond the `/quest-review` each started agent runs itself, and wait on no PR.
The final summary names each queued PR whose merge would make a quest ready, with those quests, so the user can rerun this skill once they land.
