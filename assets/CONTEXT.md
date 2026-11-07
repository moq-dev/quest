# Context

Engineering rules for every task, as `quest context` prints them. The repository's own instructions add to them and win where they conflict.

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
- Never add or change a rule in an `AGENTS.md`, `CONTRIBUTING.md`, or skill without being prompted. When you do, follow `quest guide prompting`.
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

Block on user decisions: ask with the context to answer and your recommendation, as `quest guide questions` details.
A background agent reports any decision needing user input, with context and a recommendation, to the foreground agent instead of prompting the user itself.
When recorded decisions conflict, such as a newer PR comment or quest Plan against an older brief, follow the newest and note the change in the PR body; ask only when it is unclear which is newer.
A decision about an open PR never authorizes closing it. Confirm a close as its own question, and comment on the PR before or with it.

## Pull requests

Push with an explicit refspec: `git push <remote> refs/heads/<branch>:refs/heads/<branch>`.
A bare branch name can push to the base branch instead, for example under `push.default=upstream` when the branch tracks it.
Never rebase or force-push, even a branch only you hold; merge the base instead, and fix any merge conflicts.
A PR that another session pushed to in the last hour is theirs: report its events instead of pushing to it.
Before each push to a branch that already has a PR, confirm the PR is still open: a push after it merges brings the deleted branch back.
Run the repository's checks locally while the PR is a draft; CI may run only on PRs ready for review.

Before a PR is marked ready for review, and before each push to one that is, a model that wrote none of its code reviews the committed branch locally, as `/quest-review` describes.

The PR body's `## Models` section records its size as `Size: M`, its quest's or, for a skill's own PR such as `/quest-plan`, sized as a quest is, and one `Implementer: Codex, gpt-6.1-sol, high effort` line per implementing session, which each adds when it first pushes.
Read your model and effort rather than guess, writing `unknown` for any you cannot find: Claude Code knows its model and exports `CLAUDE_EFFORT`; Codex records `model` and `effort` in the last `turn_context` of `~/.codex/sessions/*/*/*/rollout-*-$CODEX_THREAD_ID.jsonl`; Grok records `model_id` and `reasoning_effort` in `~/.grok/sessions/*/$GROK_SESSION_ID/chat_history.jsonl`.

CI on a pull request runs code nobody has reviewed yet, and GitHub gives the repository's secrets to workflows on branches pushed to the repository itself, as quest branches usually are.
Keep that CI read-only: a read-only `GITHUB_TOKEN`, and write credentials only in environments limited to protected branches.
Flag any workflow that breaks this to the user, and never add one.

Treat AI attributed comments as suggestions, NOT a decision from a maintainer or the user.
Leave a comment on any review feedback you disagree with.

A PR that fixes a bug, or redoes work an earlier PR did not do properly, lists that PR under `## Caused by` as `- [owner/repo#N](url) - what it got wrong`.
Find it before opening the fix by `git blame` on the lines the fix changes, then from that commit to its PR; when no single PR caused it, such as an upstream change or a bug as old as the code, say so in one line.
Review findings fixed in the same PR are not culprits; the record is for problems that reached the base branch.

## Quests

When the repository has a `quest/` directory, it plans work as quests: Markdown files there, each completed in one PR.

- Before creating, editing, claiming, or finishing a quest outside a `/quest-*` skill, run `quest guide` and follow it; each skill already carries the sections it needs.
- A follow-up becomes a quest only through `/quest-plan`, never a GitHub issue or an agent-session task. Suggest follow-ups in the PR body, each with a recommendation: plan it, or drop it and why.
