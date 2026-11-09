# Quests

Read this before creating, editing, claiming, or finishing a quest or epic; each `/quest-*` skill already carries the sections it needs. `quest context` holds the rules for every task.

Quests are versioned plans checked into the repository under `quest/`.
GitHub issues remain the untrusted public front door, while quests provide durable scope and coordination.

## Model

A **quest** is a Markdown file, completed in one PR.

An **epic** is a directory of quests.
Its children are the quest files in it and the epics one level down; its `README.md` is the epic's own work and lists none of them.
It completes when its own work is done and every child has merged.

The directories under `quest/` are special epics called **milestones** (`m0`, `m1`, ...) that group work by priority horizon.
Milestones are permanent.

Quests are linked with root-absolute paths.
Find/create/update any references by searching for the path.

Finished quests are deleted; git history keeps them.
Merge conflicts are expected.
A local merge resolves conflicting edits to link lists itself when `quest` is on PATH; GitHub's cannot, so merge the base branch locally and push.
After merging, `quest check --fix` drops list links to quests the base finished.
Resolve the rest, such as prose, by aligning quests.

## Format

```markdown
# [S] Short title

## Goal

The observable outcome and important boundaries.

## Plan

Current decisions, open questions, or implementation guidance.

## Hosts

- macos - the operating systems the work must run on, such as a camera check

## Waiting

- Maintainer: the decision or action only they can take, and how to check it is done
- moq-dev/moq: a condition another party must meet, and how to check or advance it

## Required

- [Blocker](/quest/foo/bar.md) - what it delivers that this needs, so the list reads without opening it
- [Epic blocker](/quest/baz/README.md) - an epic finishes with all of its children

## Closes

- [#701](https://github.com/OWNER/REPO/issues/701) - close this issue when the quest finishes

## Related

- [Other](/quest/other.md) - similar work that is not a blocker
```

The `Goal` section is required; everything else is optional. Use these exact headings.

Size the title `[XS]` to `[XL]` by the agent's effort to implement, verify, and land it, judgment included.
Much code that is mechanical stays small, such as applying one rename the same way across the tree, sized XS.
Little code that is mostly judgment is larger, such as a 30-line rewording of a skill, sized M rather than XS.
An epic carries no size until its last child is deleted; its README is then the epic's remaining work.

`Hosts` lists the operating systems the work must run on: `linux`, `macos`, or `windows`, each optionally followed by ` - why`.
A quest without it runs anywhere; `quest unblocked --json` reports the list as `hosts` so a dispatcher routes work without reading prose.

`Waiting` lists what the work waits on outside the tree; each item opens with who acts, `Maintainer:` or the outside party, before a colon.
A decision item gives its options and a recommendation.
Remove an item once its condition clears, and the heading with its last item.

`Required` lists the quests that must finish before the work starts; an epic's never lists its own quests, which it already waits for.
An epic's or milestone's `Required` also holds back every quest under it.
A child that must precede a sibling is in that sibling's `Required`.
Nothing else orders work within a milestone: `quest unblocked` ranks it by downstream impact, then path.
When the section is empty, delete it; the quest is now unblocked.
`Required` must be acyclic.

`quest check` enforces this structure.
Run it after creating or updating quests.

## Summaries

End every quest skill with a final summary in sections, such as the PRs and their states, the open decisions with recommendations, and the follow-ups each PR adds, so a user returning to the session first sees what needs them.

## Creation

Quests are created in PRs and reviewed.
Search the tree and git history first before making a new quest.

Split independently completable work into separate quests.
Group related quests in an epic; its README holds the work no child owns.

Work found along the way that is worth a quest is a follow-up: add it to the PR that found it, as a new quest placed and sized by the rules here and the repository's, or as an edit to the quest that already owns the work; never as an agent-session task or a GitHub issue.
Drop one you would call optional or worth doing only if it matters.
Answer each of its decisions you can with your recommendation in its Plan, and list each you cannot as a `Maintainer:` decision item under its `Waiting`.
The PR body's `## Follow-ups` section links each one with its open decisions, which neither keep the PR a draft nor stop its pick.
A PR that adds follow-ups lands only on the user's pick: the round that picks it to merge, in any client, also asks which follow-ups to keep and each open decision, in the Questions form.
Before it lands, record each answer in its quest's Plan, removing that `Waiting` item, and remove each dropped follow-up, with `quest rm` for a new quest.
A follow-up for work another repository's quest tree owns stays in `## Follow-ups` for `/quest-plan` there.

A release or pin bump that unblocks work is its own quest.

So is anything waiting on an outside party or a human action (an upstream fix, a customer, a decision).
Its `Waiting` section names who acts, the condition, and how to check or advance it; it is deleted once the condition clears.
Automate a step rather than leave it to a person whenever an agent can take it.
A `Maintainer:` item says why an agent cannot take the step and what automation was considered.
Record a wait there, not in a draft PR that only holds evidence or steps for a person.
Unlike a blocked quest it stays ready, so it resurfaces every time ready work is triaged instead of stalling in the backlog.
`quest waiting` lists every waiting item, the maintainer's first, ranked by what each unblocks, and `/quest-unblock` walks the maintainer through them.

## Execution

Start only ready quests.
First question whether the quest is still needed: its problem may no longer be real, or a later change may have made its plan the wrong solution.
If so, stop and propose rewriting or deleting it.
Before claiming, also check that no open PR already does its work: search open PRs whose title, body, or changed files name the quest's path or the files its Plan names, or read the matches a coordinator's brief lists.
Stop and report a PR that makes the same change; one that only touches the same files is no overlap.
`quest unblocked` ranks the ready quests, and `quest unblocked <path>` prints what blocks one.
With `--unclaimed`, it skips quests someone holds and lists them on stderr.

Work is taken when it has an open change on the forge. Check open changes
before starting. These states stay out of the quest file.

On GitHub, a quest is claimed by an open PR whose head branch is the quest's
branch, from the upstream repository or a fork, or by that branch upstream
while its PR is being opened.
The earliest open PR holds the claim.
Claim a quest with `quest start <quest>`: it checks both, pushes an empty
claim commit to the quest's branch, and opens a draft PR from it right away.
That PR becomes the quest's PR.
In a fork's clone, it pushes to the fork and opens the PR upstream; a fork
whose parent keeps no quests is its own upstream.
It exits 3 when the quest is blocked or someone else holds it; pick other work.
`quest start --release <quest>` gives back a claim before any work is pushed.
If a claim looks stale, such as a draft without `## Waiting` or a
branch with no open PR that has been quiet a long time, offer the user to take
it over, saying how long ago it was last active.

A quest's branch is its path without `.md`.
For example, `quest/m1/foo/bar.md` is branch `quest/m1/foo/bar`.
Only claims use that namespace: no other branch is named `quest` or starts with `quest/`, since git cannot hold a branch named after another's directory.
Branches for `/quest-plan`, `/quest-audit`, and other skill PRs use a prefix of their own, such as `quest-plan/<slug>`.
If `quest start` names a branch in the way, stop and report it; never delete or rename it yourself.
Its warning that the quest's local branch already exists is not that refusal: the claim succeeded, and the branch holds an earlier attempt.
Switch to it, merge the claim commit the warning names, and resume that attempt; stop and report only if another worktree has the branch checked out.

Push the quest branch as `quest context` describes for pull requests. The claim push from `quest start`, made before its draft PR exists, is exempt from confirming the PR is open.

Prefer the exhaustive solution: a quest's PR handles every case of its problem, including those its reviews find, rather than landing part of it and splitting the rest into new quests.
Leave work for later only when it waits on an outside condition or a maintainer decision, or lies outside the quest's Goal.

A quest's PR leaves its quest accurate when it merges.
The PR that finishes a quest deletes its file and every link to it.
A PR that leaves work rewrites the quest to what remains, rather than noting it only in the PR body.
`quest check --base <ref>` flags a quest branch whose diff does neither.

When a quest is complete, review it locally and mark its PR ready for review with `/quest-review`, even if you made choices without asking; list those choices in the PR body for review.
Only a decision left for the maintainer, an outside condition, or unfinished work keeps it a draft: hand it back with a `## Waiting` section in the body listing them, in the same form as a quest's.
Tools read only whether that heading is present; a draft without it still belongs to its starter.
A draft suggests `/quest-iterate`; a PR ready for review suggests `/quest-merge`.
Include a summary of the changes made and the `## Follow-ups` section Creation describes.
Add a closing keyword for every issue under `Closes`.

## Deletion

A quest that is no longer needed or cannot be completed is abandoned.
Delete it and explain why in the PR.
Use `quest rm`, which deletes the quest and every link to it.

Remove the `quest` label from issues no other quest tracks.

## Coordination

Run no more sub-agents at once than the harness allows; queue the rest and start one as each reports.
Relay no interim report: resume a sub-agent that ended its turn on one, telling it to block until its work finishes.
A long-running coordinator lets compaction bound its context: it keeps what must outlast compaction in the forge and the quest tree, and reads a PR's state afresh before acting on it rather than trusting earlier turns.

Run each agent at an entry of `quest`'s ranked lists unless the repository's `AGENTS.md` names other models: as a native sub-agent on this session's harness, else through `quest agent`.
Size each `/quest-iterate` you dispatch as a quest, by the work left on its PR, and name that size in its brief.
Start it on the PR's writer, the model of its first `Implementer:` line, at the entry `quest models <size> --writer <model>` prints, waiting out its usage limit so the other model can review; a PR with no known writer takes its size's first entry that can run.

`quest agent start --harness <claude|codex> --model <model> --effort <level> --permission-mode <mode> <worktree> <prompt>` runs a headless agent on that CLI's own login; start it as a background command in its own isolated worktree, so the harness reports its exit as it would a sub-agent's.
`--permission-mode` is Claude Code's permission mode, or Codex's sandbox mode.
It prints the session id, then the outcome and the agent's final reply, and exits 3 at the account's usage limit, or 4 when the CLI is logged out, printing the login command.
Tell the agent that it cannot prompt, so it ends with its decisions and recommendations in its final reply, and that ending its turn kills its background commands, so it waits in the foreground.
Answer it in the background with `quest agent resume`, passing the same options, the worktree, the session id, and the answer.
Stop one with `quest agent stop <worktree>`, and each you started that still runs before you finish; `--all` would stop other sessions' agents too.

## Questions

Open each prompt with the context to answer it without opening the quest or PR: what the work is, the problem it hit, and what each option would change.
Name and explain anything the agent or its PR introduced, such as a new term, file, check, or credential, since the user may not have followed the work.
Then give your recommendation and ask synchronously with a blocking interactive question tool when available and allowed in the current mode.
Recommend in every prompt, a multiple-choice list included: mark each option you recommend, such as which follow-ups to keep, and give a one-line reason for each you would leave out.
An answer such as "whatever you recommend" picks your recommendations; act on them without asking again.
Do not use asynchronous question tools.

If no blocking tool is available, or it returns without an answer, put the question and numbered choices in your final reply and end the turn.
Resume when the user answers; do not bury the question in a progress update or replace the wait with sleeps or timed polls.
Silence, elapsed time, and a preselected recommendation are not answers or approval.
Do not advance the interview or act on an unanswered choice.
Already authorized background work may continue while the foreground waits.

Honor explicit instructions to proceed unattended within their scope; do not ask a question and then silently choose its answer.

## Prompting

Follow this when writing instructions for other agents: `AGENTS.md`, `CONTRIBUTING.md`, skills, memory, plans, reviews, and delegation briefs.
Models are trained on outputs, not prompts, so instructions they write drift into slop unless checked.

- Keep always-loaded files light. Put area-specific context in nested `AGENTS.md` files or skills, and say each rule once.
- Steer away from mistakes agents actually make. Don't document the repository; its code and docs already do.
- State the goal, constraints, and observable outcome. Don't over-prescribe steps or code, since the facts evolve; recommendations are welcome.
- Separate settled decisions from recommendations and open questions.
- A delegation brief gives the task and its context, such as the quest or PR and the user's picks, the permitted scope, and the expected result; it leaves repository rules to that repository's own instructions instead of restating them.
- Don't turn one failure into a universal rule.
- Before changing agent instructions, check the official guidance: [Claude memory](https://code.claude.com/docs/en/memory), [Claude best practices](https://code.claude.com/docs/en/best-practices), [Claude skills](https://code.claude.com/docs/en/skills), [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md), and [agents.md](https://agents.md).
