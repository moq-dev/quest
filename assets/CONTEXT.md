# Context

Engineering rules for every task, as `quest context` prints them. The repository's own instructions add to them and win where they conflict.

## Required

- Before editing a file, read every `AGENTS.md` on its path from the root, since not every agent loads nested ones. Read the repository's `CONTRIBUTING.md` before a PR, and its `REVIEW.md`, if any, before a review.
- Reproduce a bug before fixing it, and fix it at the root cause, flaky tests included. Never work around one with a retry, sleep, timeout, or looser assertion.
- Fail loud and early: error on unsupported or malformed input instead of warning and continuing, and decide a supported path at setup from known capabilities instead of trying one at runtime and silently falling back. A partial failure fails the whole; never report partly failed work as done.
- Treat anything received over the network as untrusted and potentially hostile. Bound what a peer can make you hold by design, not with a constant. Run no code from a PR whose author lacks write access: it runs with your credentials.
- For core functionality, build the bold, comprehensive solution, not the average one: handle every case, land it whole instead of a part plus follow-ups, and refactor whatever stands in the way. Keep everything outside the core minimal.
- Be adversarial: attack your own approach, reports, reviews, and other PRs as hard as anyone else's, and argue for the best approach over the first one that works.
- Passing checks don't show a change works. Before review, exercise it on its real surface, such as the built binary, the running app, or the endpoint, and verify core functionality a second independent way, such as a property or differential check, a model, or a measurement. Measure performance claims. Put what you ran and saw in the PR body's `## Validation`; a change with no behavior to exercise says so.
- Keep CI fast, so bold changes can be tried and thrown away cheaply: every test runs in CI, but the merge gate holds only fast, high-signal ones, and slow or expensive ones, such as other platforms, run nightly. A PR that slows the gate says by how much and why it is worth it.
- Unit tests mock time instead of depending on wall-clock timing or sleeps, and cover edge cases, not old bugs or trivial values.
- A lasting fact or instruction about a project belongs in its repository, not agent memory. Propose checking it in, to the nearest `AGENTS.md` or its quest; change no rule until the user agrees, then follow `quest guide prompting`.
- In a public repository, never mention customers, partners, or prospects, or link to a private repository its maintainer doesn't own. Justify work on its merits.

## Important

- Everything must be worth its weight: code, dependencies, tests, CI jobs, CPU, memory, and build time. Remove what doesn't earn its cost; deleting code beats adding it. Every change needs a consumer that uses it now or is planned, and stays private until one needs it.
- Prefer the net simpler result: reuse what exists, inline simple helpers, or narrow the scope, when that makes the result simpler overall. Say what was dropped.
- Take a dependency only for nontrivial non-core functionality, at its newest stable version.
- Do not bump package versions unless asked.
- Comments explain the non-obvious why, never the history, and every export gets one plain line, the way you'd say it out loud.
- Audit the code you read as you go, even outside your task: bugs, security, these rules, dead code, and what could be simpler. Fix in the same PR the easy findings and any docs or comments your change outdates; suggest the rest as follow-ups.
- Say it once, in the fewest words that hold up.

## Public API

- Report the public API and wire impact of every change in the PR description.
- A breaking change to the public API or wire marks its title with `!` and says how to migrate; a behavior change alone takes no `!`.
- Never add `foo_with_x`, `foo_checked`, or a compatibility shim. Make the breaking change to `foo` instead.
- Let the type system make misuse unrepresentable.
- Avoid callback parameters and 4+ arguments. Return a handle; take a struct.
- Under a module namespace, use short names that don't repeat it: `http::Client`, not `http::HttpClient`.

## Workspace

Work in your own worktree, reusing a suitable one you already own; read-only discovery needs no new checkout when your context or own checkout answers it.
Put scratch, such as PR bodies, review drafts, logs, patches, helper scripts, and temporary clones, in its `.tmp/`, never `/tmp` or a directory other agents share, so it disappears with the worktree.

Before ending a task, pausing for a decision, or handing off, commit a checkpoint and report what remains and which checks passed or did not run.
Finish with a clean checkout: intended changes committed and pushed, incidental generated changes restored, and pre-existing or unrelated changes preserved.

Run CPU-heavy commands, such as builds, tests, model checkers, and browsers, through `quest gate <command>`, which queues until the host has room; model calls like `quest review` and servers stay out.
Never work around the queue by polling the load average or capping agents yourself; cancel a gated command only when you no longer need its result.
Run it in the foreground and read its exit code directly, not through a pipe.
Never end a turn or report while your background work runs, and never poll it with `sleep`, status checks, or busy loops: block on the harness's own wait for that task, at its longest interval, saying nothing between waits.
To wait on a PR's CI or reviews, use `quest wait`, re-running one that times out with the `--since` it printed, so activity during the first wait is still reported.
A sub-agent ends its turn only with a final result or a question. Its final report holds only what its caller acts on, such as its PR's URL, state, and head, and each decision it needs with a recommendation; details go in the PR body.
Back out when progress stalls rather than burn tokens; a gate's queue or a long command still running is not a stall.

## Questions

Make every reference you show the user clickable: link issues, PRs, and commits by full URL, as `[owner/repo#123](https://github.com/owner/repo/pull/123)`, never a bare `#123`.
Sub-agents report those URLs for the parent to link.

Block on user decisions: ask with the context to answer and your recommendation, as `quest guide questions` details.
An agent that cannot prompt never picks an answer the user owns: it puts each decision, with context and a recommendation, in its report and under `## Waiting` in its PR.
A plan is a starting point: when a finding undercuts it, say what changed and propose alternatives with your recommendation instead of following it through.
When recorded decisions conflict, such as a newer PR comment against an older brief, follow the newest and note the change in the PR body; ask only when it is unclear which is newer.
A decision about an open PR never authorizes closing it. Confirm a close as its own question, and comment on the PR before or with it.

## Pull requests

Merge the base only when the branch conflicts with it or a landing step, such as `quest merge` or a merge queue, refuses the head, and resolve the conflicts in that merge; a branch only behind needs none: landing tests it on the current base.
Before each push to a PR's branch, confirm the PR is still open, since a push after it merges restores the deleted branch.

Before a PR is marked ready for review, a model other than its latest writer reviews the committed branch locally, as `/quest-review` describes; a later push needs a new review unless `/quest-merge` exempts its changes.
Anything AI-attributed, such as an online reviewer's findings, is a suggestion, not a maintainer's decision: address findings already posted on the head, reply to feedback you disagree with, and never wait for an online review, since the queue waits for any approval the base requires.
Request a review only from a reviewer whose approval the base requires and that never ran on the head.
Once you fix or refute an automated reviewer's finding, say so in its thread and resolve it, since such a reviewer may approve only after its threads are resolved.

The PR body's `## Models` section records its size as `Size: M` (its quest's, or for a skill's own PR, as a quest is sized) and one `Implementer: Codex, gpt-6.1-sol, high effort` line per implementing session, moved last whenever it pushes; write the model's ID, and `unknown` for whatever the harness doesn't report.

Keep pull request CI read-only (a read-only `GITHUB_TOKEN`, write credentials only in environments limited to protected branches): quest branches are pushed to the repository, so their workflows get its secrets. Flag a workflow that breaks this.

A PR that fixes a bug, or redoes work an earlier PR did badly, lists that PR under `## Caused by` as `- [owner/repo#N](url) - what it got wrong`, found by `git blame` on the lines the fix changes or named in its quest's Plan, and confirmed in that PR's diff to introduce the defect, not merely touch the lines, defer the work, or keep older behavior, else traced further back with blame, or says in one line that no single PR caused it, such as an upstream change or a bug as old as the code.
Review findings fixed in the same PR are not culprits.

## Quests

When the repository has a `quest/` directory, it plans work as quests: Markdown files there, each completed in one PR.

- Before creating, editing, claiming, or finishing a quest outside a `/quest-*` skill, run `quest guide` and follow it; skills carry the sections they need.
- Add follow-ups worth a quest to your PR as `quest guide` describes, never as GitHub issues or agent-session tasks.
