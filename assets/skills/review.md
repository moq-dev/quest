---
description: Review a PR's branch locally with a model other than its latest writer, then mark it ready for review.
guide: Creation, Execution, Summaries, Questions
skills: merge
---

The argument is the PR; without one, it is the current branch's.
If its body lists open decisions, other than its follow-ups', or unfinished work, offer `/quest-iterate` first.

Take the PR with `quest iterate <pr> [token]`, passing a hold token your brief gives or you already have, and keep the token it prints.
If it refuses, stop and report what it printed; taking over a hold is the user's choice.
The exception is a draft with no `## Waiting` section, which is still its starter's: when you started it, or its starter delegated this review to you, review it without a hold.

Work in a checkout of the PR's head, detached when another worktree holds its branch.
Whenever your checked-out branch is not the PR's head branch, pass `--branch <head-branch>` to each `quest review`, so its rounds and record follow the PR.
Commit everything, and unless the repository's local checks already passed on that commit, run them and fix any failure the branch causes.
A PR whose author lacks write access gets no local run: leave its checks to CI, and run a `quest` it cannot modify, such as an installed release, from outside its checkout with `--root`.
A check failure that reproduces unchanged in a checkout of the base branch is pre-existing rather than the PR's: record the command and both failures in the PR body's validation, go on to review and readiness, and add a follow-up for it unless an open PR already fixes it.
Never alter the repository's harness to get a pass, such as by disabling a tool, unsetting its environment, or skipping a check, nor report an altered run as its checks.

Run no new round when a review already counts for the committed head, as `/quest-merge` defines below, and leaves no finding unrefuted: go on to pushing and marking it ready.
`quest status <pr>` reads the pushed head, so trust its `review-record` line only while its `head` line is the committed head.
If you judge the change too trivial to review, skip the review instead and record the skip and its reason in `## Review`.

Otherwise, review the committed branch with `quest review --base <remote>/<base>`, in the foreground; a round takes minutes.
It picks a reviewer other than the model that changed the branch last, at an effort the PR's size sets, with a second reviewer beside it.
It reads that model, and off a quest branch the size, from the PR body's `## Models` record: open the draft PR and write the record before the first round, as `Size: M` and `Implementer: Claude Code, claude-opus-5-5, high effort`.
Pass `--exclude-model` or `--size` only for a PR whose body cannot hold the record.
Where the repository's root instructions name other reviewers, pass them with `--harness`, `--model`, and `--effort`, which runs that reviewer alone.
Each round rewrites the PR body's `## Review` section, so add context only after it, and write a round's record by hand only when it printed `record skipped`.

Each round ends with a `next` line: follow it until a round of the head reports no finding you have not refuted; never block on the score.
Fix every finding relevant to the PR in the PR: review findings you do not refute, gaps the change exposes, and bugs in the code it touches; only out-of-scope discoveries become follow-ups.
Refute a finding only with evidence the reviewer cannot rebut: a `path:line`, a command's output, or a recorded maintainer decision.
A finding the reviewer keeps against such a refutation is a decision for the user.
Write each round's `--responses` file in the checkout's `.tmp/`.

At a `next checkpoint` line, which a reviewer's every third round prints when it reports findings, stop before fixing them and reconsider the approach.
Findings that keep coming usually mean the approach is wrong, not the last fix: brainstorm other designs that would avoid the whole class of findings, favoring simpler ones, and compare them with the current one.
Report the alternatives and what remains, recommending to continue, rethink the approach, merge as is, or drop the PR, and let the user decide.
Record each design change, including a rethink the user picks, in a PR comment that starts with `Design change:`, and start the next review with `quest review --new`, which restarts the count.

Either reviewer out of quota or logged out is an outage, not a skip: stop reviewing rather than go on with the other alone, keep the PR a draft, hand it back, and report the outage.
Its `## Waiting` item names the reviewer, its error, and the check, such as `Codex: out of quota until 2026-11-03 15:00 UTC; check that quest review runs`, with the reset time `quest review` prints when it exits 3 on a usage limit; a logged-out reviewer waits on `Maintainer:`, with the login command `quest review` prints.
Once the reset passes or the login is restored, the item has cleared: whoever finds it runs `/quest-review` on the PR.

Push, then mark the PR ready for review: with `quest ready <pr> <token>`, which also drops its `## Waiting` section, or with `gh pr ready <pr>` for a draft you reviewed without a hold.

Summarize the review, with its last round's score and rationale, and CI from `quest status <pr>`.
Name any decisions the review raised without answering them, then ask the user with your recommended action:
- `/quest-merge`: the PR is landable as `/quest-merge` defines it, or will be once fixed with no decision left for the user, such as failing checks or unaddressed automated review findings; `/quest-merge` runs `/quest-iterate` on it first.
- `/quest-iterate`: the review raised significant issues or decisions, which it settles with the grill skill's interview.
- skip: the PR should not be merged yet.
- `/quest-delete`: the quest should be deleted.

While its required checks are still running, report that instead of asking; `/quest-run` asks once they finish.

If you took a hold, hand the PR back with `quest release <pr> <token>` before you ask, report, or go on to `/quest-merge`.
To go straight on to `/quest-iterate` in this session, pass the token to its `quest iterate` instead, which keeps the hold.
