---
description: Start multiple quests in parallel.
---

Before you begin, run `quest guide` and read its output completely.

Your goal is to execute many quests in parallel.
The scope consists of all ready quests that are not claimed.
Run `quest unblocked --unclaimed --json` for unclaimed ready candidates in milestone priority, descending downstream impact, then tree order.
The count is distinct transitive dependents; other prerequisites may still remain.
Use that order when dispatching, and recompute after the quest tree changes.
An explicit argument takes precedence: filter to the selected quests/epics and honor their requested order.
It lists each skipped claim on stderr with how long ago it was last active; offer the user any that look stale, as the guide describes.
Each agent claims its quest with `quest start`, which refuses one claimed since; a refusal is a skip, not a failure.
For a quest waiting on an outside condition, check whether it has cleared before recommending.

Start every quest you would recommend starting, without asking: well planned, with no blockers or conflicts with quests already started.
Print each quest you skip and why, suggesting `/quest-plan` for any with significant design issues.

Ask only when unsure, such as a quest that may not be worth implementing or may not be worth doing now.
Present those one at a time: a short paragraph explaining the problem, the quest's goal, and your recommendation, then one synchronous question following the guide's Questions section, offering:

- `/quest-start`: If the quest should start now.
- skip: If the quest should not be started yet.
- deprioritize: If the quest should wait behind other work; `/quest-plan` moves it down.
- `/quest-delete`: If the quest should be deleted.

Start each quest in a background sub-agent with its own isolated worktree, since agents cannot write to a worktree their parent created.

Each agent reports back only when done or blocked.

When done, each agent's claim PR holds its work, still a draft if decisions or unfinished work remain.
Its report lists every open decision with a recommendation.
Report each sub-agent's final status, staying silent on interim notifications, but do not monitor their PRs.

As each agent reports, explain its result in a few lines: its PR, whether it is still a draft, and its open decisions with recommendations.
Stop at the PRs, beyond the `/quest-review` each started agent runs itself: never offer or run `/quest-review`, `/quest-iterate`, or `/quest-merge` on them. Deciding them is `/quest-complete`'s job, run as its own session.

Once every sub-agent has finished, plan the follow-ups the agents suggested, as the guide describes, in the foreground.
Include quest context, as many quests are concurrently in flight.

Once every sub-agent has finished, remove local worktrees and branches whose tip is the head of a merged PR; squash merges leave that tip off the base branch.
Leave the worktree you are running in and any holding uncommitted work; list those in your summary.

## API keys

With an `api` argument, bill agents to API keys instead of this session's account: run each as a headless agent through `quest agent` rather than as a sub-agent.
`QUEST_API_KEYS` lists the keys, separated by whitespace; refer to each by its 1-based position.
`quest agent` resolves any 1Password `op://` entries in one `op inject` on first use, keeps the keys in a user-only store, and gives each agent only its own key, so never resolve, read, or show a key yourself.
A 1Password service account token in `OP_SERVICE_ACCOUNT_TOKEN` makes resolution promptless.
Stop and report if it says `QUEST_API_KEYS` is unset or the agent CLI is not installed.

Start each agent as a background command, in its own isolated worktree, so the harness reports its exit as it would a sub-agent's:
`quest agent start --harness <claude|codex> --key <position> --model <model> --effort <level> --permission-mode <mode> <worktree> <prompt>`.
Pass this session's model, effort, and permission mode; Codex takes its sandbox mode.
It prints the session id first, then the cost when the agent reports one, the outcome, and the agent's final reply.
Tell the agent that it cannot prompt, so it ends with any decisions and its recommendations in its final reply, and that ending its turn ends the process and kills its background commands, so it waits in the foreground.
Ask the user, then resume that session in the background with the answer, as you would message a sub-agent: `quest agent resume` with the same options, the worktree, the session id, and the answer.
Stop one agent with `quest agent stop <worktree>`.
When the spawn ends, run `quest agent stop --all`, which stops any agent still running and deletes the resolved keys.

Assign quests to keys round-robin.
Exit status 3 means the key's credit is exhausted: drop that key for the rest of the spawn and resume the session on the next key.
Once every key is exhausted, start nothing new and never fall back to this session's account.
List each interrupted quest with its worktree and session id so the user can resume it later.
