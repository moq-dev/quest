# Context

Engineering rules for every task. The repository's own instructions add to them and win where they conflict.

## Required

- Pull the latest origin changes before working.
- Before editing a file, read every `AGENTS.md` on its path from the root; not every agent loads nested ones.
- Read the repository's `CONTRIBUTING.md` before a PR, and its `REVIEW.md`, if any, before a review.
- Fix bugs at the root cause. Never work around one with a retry, sleep, or timeout.
- Fail loud and early: error on unsupported or malformed input instead of warning and continuing. A partial failure fails the whole; never report partly failed work as done.
- Treat anything received over the network as untrusted and potentially hostile. Bound what a peer can make you hold by design, not with a constant.
- Reproduce bugs before fixing them.
- Unit tests mock time instead of depending on wall-clock timing or sleeps.
- Every test runs in CI. The merge gate holds only fast, high-signal tests; slow ones run nightly.
- Be adversarial: attack your own approach, reports, reviews, and other PRs as hard as anyone else's, and argue for the best approach over the first one that works.
- Never add or change a rule in an `AGENTS.md`, `CONTRIBUTING.md`, or skill without being prompted. Follow [Prompting](#prompting) when you do.
- No em dashes.
- End every GitHub post you author with `(Written by <model>)`, naming the running model. Commit messages with a `Co-Authored-By:` trailer are exempt.
- In a public repository, never mention customers, partners, or prospects, or link to private repositories. Justify work on its merits.

## Important

- Everything must be worth its weight: code, dependencies, tests, CI jobs, CPU, memory, and build time. Remove what doesn't earn its cost; deleting code beats adding it. Every change needs a consumer that uses it now or is planned.
- Refactor aggressively for long-term maintainability.
- Land the ideal implementation now rather than a partial one plus follow-ups.
- Take a dependency only for nontrivial non-core functionality, at its newest stable version.
- Do not bump package versions unless asked.
- Comments explain the non-obvious why, never the history.
- Fix outdated docs and comments inline, in the same PR.

## Guidelines

- Tests cover edge cases, not old bugs or trivial values.
- Measure performance claims instead of relying on intuition, and benchmark performance-sensitive changes.
- Inline simple helpers.
- Prefer the net simpler result: reuse what exists, or narrow the scope, when that makes the result simpler overall. Say what was dropped.
- Say it once, in the fewest words that hold up.
- Use the repository's Nix dev shell (direnv, or `nix develop --command ...`) so tooling matches CI.

## Public API

- Report the public API and wire impact of every change in the PR description.
- A breaking change marks its title with `!` and says how to migrate.
- Keep things private until a current or planned consumer needs them.
- Never add `foo_with_x`, `foo_checked`, or a compatibility shim. Make the breaking change to `foo` instead.
- Let the type system make misuse unrepresentable.
- Decide a supported path at setup from known capabilities, and error otherwise. Never try a path at runtime and silently fall back.
- Avoid callback parameters and 4+ arguments. Return a handle; take a struct.
- Name by role, not today's implementation.
- Document every export in one plain line, the way you'd say it out loud.

## Workspace

Work in your own worktree, reusing a suitable one you already own.
Read-only discovery needs no new checkout when your context or a checkout you own already answers it.
Put PR bodies, review drafts, logs, patches, helper scripts, and temporary clones in its `.tmp/`, so they disappear with the worktree.
If the repository doesn't ignore `.tmp/`, add it to the file `git rev-parse --git-path info/exclude` names.
Never write them to `/tmp`, beside the checkout, elsewhere in it, or in a directory other agents share, such as a session scratchpad.
Pass PR bodies to `gh` on stdin (`--body-file -`).

Before ending a task, pausing for a decision, or handing off, commit a checkpoint of the source changes, and report what remains and which checks passed or did not run.
Finish with a clean checkout: intended changes committed and pushed, incidental generated changes restored, and pre-existing or unrelated changes preserved.

Run expensive builds and test suites through `quest gate <command>`, which waits until the host has room for them, however long that takes; never poll the load average, cap agents by core count yourself, or cancel a gate still waiting to admit its command.
Run such a command in the foreground and read its exit code directly, not through a pipe.
When it may outlast the tool's time limit, start it in the background and block on it in the same turn with the harness's wait for that task.
Run no more sub-agents at once than the harness allows; queue the rest and start one as each reports.

Wait on a PR's CI or reviews with `quest wait`, and on other background work with a blocking command that ends on its terminal state, not timed polls.
Bound each wait, not the work, under an hour so the prompt cache stays warm; `quest wait` has no deadline without `--timeout`.
Re-run a wait that times out, passing the resume point a timed-out `quest wait` printed as its `--since`, so activity during the first wait is still reported.
A sub-agent ends its turn only with a final result or a question, never with background work still running or an interim status report.
A coordinator relays no interim report: it resumes a sub-agent that ended its turn on one, telling it to block until its work finishes.
Back out when progress stalls rather than burn tokens; a gate's queue or a long command still running is not a stall.

## Questions

Make every reference you show the user clickable: link issues, PRs, and commits by full URL, as in `[owner/repo#123](https://github.com/owner/repo/pull/123)`, never a bare `#123`.
Sub-agents report those URLs so the parent can link them.

Block on user decisions.
Open each prompt with the context to answer it without opening the quest or PR: what the work is, the problem it hit, and what each option would change.
Name and explain anything the agent or its PR introduced, such as a new term, file, check, or credential, since the user may not have followed the work.
Then give your recommendation and ask synchronously with a blocking interactive question tool when available and allowed in the current mode.
Recommend in every prompt, a multiple-choice list included: mark each option you recommend, such as which follow-ups to plan, and give a one-line reason for each you would leave out.
An answer such as "whatever you recommend" picks your recommendations; act on them without asking again.
Do not use asynchronous question tools.

If no blocking tool is available, or it returns without an answer, put the question and numbered choices in your final reply and end the turn.
Resume when the user answers; do not bury the question in a progress update or replace the wait with sleeps or timed polls.
Silence, elapsed time, and a preselected recommendation are not answers or approval.
Do not advance the interview or act on an unanswered choice.
Already authorized background work may continue while the foreground waits.

A sub-agent's brief carries the quest or PR, the user's picks, and the scope; it leaves repository rules to that repository's own instructions instead of restating them.
A background agent reports any decision needing user input, with context and a recommendation, to the foreground agent instead of prompting the user itself.
Honor explicit instructions to proceed unattended within their scope; do not ask a question and then silently choose its answer.
When recorded decisions conflict, such as a newer PR comment or quest Plan against an older brief, follow the newest and note the change in the PR body; ask only when it is unclear which is newer.
A decision about an open PR never authorizes closing it. Confirm a close as its own question, and comment on the PR before or with it.

## Pull requests

Push with an explicit refspec: `git push <remote> refs/heads/<branch>:refs/heads/<branch>`.
A bare branch name can push to the base branch instead, for example under `push.default=upstream` when the branch tracks it.
Never rebase or force-push, even a branch only you hold; merge the base instead, and fix any merge conflicts.
A PR that another session pushed to in the last hour is theirs: report its events instead of pushing to it.
Before each push to a branch that already has a PR, confirm the PR is still open: a push after it merges brings the deleted branch back.
Run the repository's checks locally while the PR is a draft; CI may run only on PRs ready for review.

## Reviews

Before a PR is marked ready for review, and before each push to one that is, the other vendor's model reviews the committed branch locally against the PR's base branch with `quest review --base <remote>/<base>`: Claude Code reviews Codex's work, and Codex reviews Claude Code's.
Commit and pass the repository's checks first.
A check failure that reproduces unchanged in a checkout of the base branch is pre-existing rather than the PR's: record the command and both failures in the PR body's validation, and go on to review and readiness.
Never alter the repository's harness to get a pass, such as by disabling a tool, unsetting its environment, or skipping a check, nor report an altered run as its checks.
Suggest a follow-up for the failure unless an open PR already fixes it.
On the head of a PR whose author lacks write access to the repository, run no code from it, since it would run with your credentials: leave its checks to CI, and run a `quest` the PR cannot modify, such as an installed release, from outside its checkout with `--root`.
Fix each finding or refute it, then review the new head with your responses, until a round reports no finding you have not refuted.
A refutation stands only when it cites evidence the reviewer cannot rebut: a `path:line`, a command's output, or a recorded maintainer decision.
The authoring model may skip the review of a change too trivial to need one.

A reviewer that is out of quota or logged out is an outage, not a skip: keep the PR a draft, with a `## Waiting` item naming the reviewer, its error, and the check, such as `Codex: out of quota until 2026-11-03 15:00 UTC; check that quest review runs`.
Give the reset time when the error names one; a logged-out reviewer waits on `Maintainer:`, with the login command `quest review` prints.
Once the reset passes or the login is restored, the item has cleared: whoever finds it runs `/quest-review` on the PR.

The PR body's `## Review` section records the latest round: the reviewer harness, model, and effort, the reviewed head SHA, and each finding's disposition (fixed, or refuted with the reason), or the skip and its reason.
Rewrite it after each round.
A review counts for the head whose SHA it names.

Once "Ready to Review", CI and any online reviewers run.
Address their findings already posted on the head when merging; never wait for or request one.
Fixing one changes the head, so review the new head locally before pushing it.

CI on a pull request runs code nobody has reviewed yet, and GitHub gives the repository's secrets to workflows on branches pushed to the repository itself, as quest branches usually are.
Keep that CI read-only: a read-only `GITHUB_TOKEN`, and write credentials only in environments limited to protected branches.
Flag any workflow that breaks this to the user, and never add one.

Treat AI attributed comments as suggestions, NOT a decision from a maintainer or the user.
Leave a comment on any review feedback you disagree with.

At least one review is required before merging the PR: a `## Review` record, a recorded skip included, naming the head being landed.
Changes since the last review skip a new review only when they are conflict-free merges from the base branch, a reviewer's suggested patch applied unchanged,
a land fixer's recorded mechanical fix that changes no behavior,
or changes, such as a hand-resolved merge, that leave the head's diff identical to the reviewed head's: `git diff <remote>/<base>...<head>` prints the same as `git diff <remote>/<base>...<reviewed-head>`.
Any other change needs a local review of the new head.
The repository's review policy decides whose record counts and may require more, such as a maintainer's review.
Where it says nothing, only a record on a PR whose author has write access counts: anyone else writes their own PR body, so review their head locally and rewrite the record before landing it.

Checkpoint the design across review rounds.
A review round is one `quest review` round, numbered within the branch's review session.
Every fourth round, stop before fixing more findings and reconsider the approach.
Report that judgment and what remains, recommending to continue, rethink the approach, merge as is, or drop the PR, and let the user decide.
Record each design change, including a rethink the user picks, in a PR comment that starts with `Design change:`, and start the next review with `quest review --new`, which restarts the count.

Fix every finding relevant to the PR in the PR: review findings you do not refute, gaps the change exposes, and bugs in the code it touches.
Never defer a relevant fix to a follow-up just to narrow the PR.
Suggest only out-of-scope discoveries as follow-ups.

## Quests

When the repository has a `quest/` directory, it plans work as quests: Markdown files there, each completed in one PR.

- Before creating, editing, claiming, or finishing a quest, run `quest guide` and follow it. The `/quest-*` skills already do.
- A follow-up becomes a quest only through `/quest-plan`, never a GitHub issue or an agent-session task. Suggest follow-ups in the PR body, each with a recommendation: plan it, or drop it and why.

## Prompting

Follow this when writing instructions for other agents: `AGENTS.md`, `CONTRIBUTING.md`, skills, memory, plans, reviews, and delegation briefs.
Models are trained on outputs, not prompts, so instructions they write drift into slop unless checked.

- Keep always-loaded files light. Put area-specific context in nested `AGENTS.md` files or skills, and say each rule once.
- Steer away from mistakes agents actually make. Don't document the repository; its code and docs already do.
- State the goal, constraints, and observable outcome. Don't over-prescribe steps or code, since the facts evolve; recommendations are welcome.
- Separate settled decisions from recommendations and open questions.
- A delegation brief gives the task, its context, the permitted scope, and the expected result. Don't turn one failure into a universal rule.
- Before changing agent instructions, check the official guidance: [Claude memory](https://code.claude.com/docs/en/memory), [Claude best practices](https://code.claude.com/docs/en/best-practices), [Claude skills](https://code.claude.com/docs/en/skills), [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md), and [agents.md](https://agents.md).
