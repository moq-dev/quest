---
description: Start multiple quests in parallel.
guide: Creation, Execution, Coordination, Summaries, Questions, Prompting
---

Your goal is to execute many quests in parallel.
The scope consists of all ready quests that are not claimed.
Run `quest unblocked --unclaimed --json` for unclaimed ready candidates in milestone priority, descending downstream impact, then path order.
The count is distinct transitive dependents; other prerequisites may still remain.
Use that order when dispatching.
As each agent reports, rerun `quest unblocked --unclaimed --json`, which reads the upstream tree afresh, and start the newly ready quests you would recommend, within the harness's agent limit: merges elsewhere and released claims make more work ready while the spawn runs.
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

Before dispatching a quest, search open PRs for one already doing its work, as the guide's Execution section describes; one listing of open PRs with their changed files covers every quest.
Skip a quest a match already implements; otherwise list the matches by URL in its brief, so the agent judges them before claiming instead of searching again.

Start each quest in a background sub-agent with its own isolated worktree, since agents cannot write to a worktree their parent created.

Each agent reports back only when done or blocked.
Once two agents report the same blocker, such as a check failure that reproduces on the base or a reviewer outage, name it with its evidence in the brief of each agent started after, and report it once, not with each agent.

When done, each agent's claim PR holds its work, still a draft if decisions or unfinished work remain.
Its report lists every open decision with a recommendation.
Report each sub-agent's final status, staying silent on interim notifications, but do not monitor their PRs.

As each agent reports, explain its result in a few lines: its PR, whether it is still a draft, and its open decisions with recommendations.
Stop at the PRs, beyond the `/quest-review` each started agent runs itself: never offer or run `/quest-review`, `/quest-iterate`, or `/quest-merge` on them. Deciding them is `/quest-complete`'s job, run as its own session.

Stop dispatching once no agent is running and no ready quest is left to start, then wrap up as below; never wait on a merge for more work.
The final summary names each queued PR, armed for auto-merge or in a merge queue as `quest status` reports, whose merge would make a quest ready, with those quests, so the user can rerun `/quest-spawn` once they land, by hand or with `/loop`.

Never plan the follow-ups agents suggest: each stays in its agent's PR body, where `/quest-merge` or `/quest-complete` plans it once the PR is queued.

Once every sub-agent has finished, remove each agent checkout `quest worktree status` lists with `quest worktree remove`, since Claude never removes a subagent's checkout; it refuses one holding unpreserved work.
Remove other local worktrees, and branches, whose tip is the head of a merged PR; squash merges leave that tip off the base branch.
Leave the worktree you are running in and any holding uncommitted work or refused removal; list those in your summary.

## Control

Answer these requests at any point, without stopping running agents:

- "finish up": start nothing new, let running agents report, then clean up and write the final summary.
- "pause": start nothing new until the user says to resume; running agents continue, and their reports are handled as usual.
- "status": a compact list of each agent with its quest, PR, state, and how long ago it started or last reported.

A report that is an API error, such as a rate limit or an overload, or a cancellation the user did not ask for, is not a result.
Resume that agent by messaging it, or with `quest agent resume` for a headless agent, so it keeps its context and checkout.
If it cannot be resumed, start a new agent with the same brief plus its claim PR, its checkout, and the token of any hold it took on the PR, which `quest status <pr>` shows, so the new one continues that work and keeps that hold rather than claiming again.
While the error persists, such as a rate limit before its reset, resume and start nothing until it clears, and report it once rather than per agent.

## Models

Start each quest on the first entry of its `models` that can run.
Fall to the next when `quest agent` reports its CLI missing or logged out, or the agent stops on a usage limit with nothing written beyond the claim commit, continuing in that checkout and claim PR.
Once a model has written anything, the PR is its: list the quest with its worktree and session id to resume after the reset.
Skip a quest whose list runs out, and report each harness's outage once.
