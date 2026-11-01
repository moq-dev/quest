---
description: Queue a reviewed PR to land, or send it to /quest-iterate.
---

Before you begin, run `quest guide` and read its output completely.

This skill runs inline in the session that picked it, never in its own sub-agent: it only decides whether the PR's head can land as is, and queues it.
It never fixes the PR, pushes, or waits on GitHub; `/quest-iterate` does the fixing, and the merge gate handles conflicts and failures after queueing.

Parse the arguments to determine the PR number, otherwise resolve it from the current context/branch.
If a draft, stop and offer `/quest-review` instead.
Take the PR with `quest merge <pr>` before acting, passing a token you already hold from another state to swap it, and keep the hold token it prints; `quest merge --help` explains holds.
If it refuses because another session holds the PR, stop and report what it printed; taking over a stale hold is the user's choice.
Hand it back with `quest release <pr> <token>` whenever you stop without queueing it, including to recommend `/quest-iterate` or to ask.

Read the PR's head, checks, merge state, reviews by head, and unresolved threads with one `quest status <pr>`.
The head is landable when:

- a `## Review` record the guide counts names it, or the guide's review exemptions cover the changes since the one it names;
- every review finding posted on it, including automated reviewers' such as CodeRabbit or Codex, is fixed on the head or answered with a refutation, and no decision is open;
- its required checks passed, other than the gate's own `quest land` check, which never reports on a head, and it does not conflict with its base.

Otherwise recommend `/quest-iterate`, saying what it needs: a review of the head, fixes, or decisions.
While its required checks are only pending, report that the pick stands until they pass; do not wait for them.

Before queueing, fetch the PR's base branch and its exact head, check out the head outside your checkout, such as a detached worktree in `.tmp/`, and run `quest --root <head-checkout> check --base <remote>/<base> --branch <head-branch>` with a `quest` the PR cannot modify, from a directory outside the head checkout: the head's files are untrusted, and a stale local base can skip the check.
A finding means the PR leaves its quest inaccurate: recommend `/quest-iterate`.

Queue the head with `quest merge <pr> <token> --land <full 40-character head SHA>`.
It makes a merge commit; add `--squash` or `--rebase` when the repository's root instructions name that method for the PR's base.
On a base that requires the `quest land` check, it queues the PR for `quest land`, whose chain merges and tests against the current base.
On an ungated base with auto-merge disabled, it refuses. Follow the repository’s own landing instructions (for example, its label queue); never retry with `--direct` unless the user explicitly asks.
On an ungated base, it refuses a head that does not contain the current base: recommend `/quest-iterate` to merge the base.
The `quest:merge` label stays on while the PR is queued or auto-merging.

Report once it is queued, and do not wait for it to merge.
Plan the PR's suggested follow-ups as soon as it is queued, as if it lands, rather than waiting for the merge, unless a coordinator such as `/quest-complete` called this skill and batches them.
A PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`; it needs the user's pick again, except where `/quest-complete` says an earlier pick still holds.
Never close a PR to unstick it, and never work around a refused merge; ask instead.
