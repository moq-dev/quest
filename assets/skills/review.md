---
description: Review a PR's branch locally with a model other than its latest writer, then mark it ready for review.
guide: Creation, Execution, Summaries, Questions
skills: merge
---

Parse the arguments to determine the PR number, otherwise resolve it from the current context/branch.
If its body lists open decisions, other than its follow-ups', or unfinished work, offer `/quest-iterate` first.

Take the PR with `quest iterate <pr>`, passing a token you already hold for it to keep that hold, and keep the hold token it prints; `quest iterate --help` explains holds.
If it refuses because another session holds the PR, stop and report what it printed; taking over a stale hold is the user's choice.
A draft you started in this session has no `## Waiting` section, nor the older `## Decisions needed`, so it is still yours and the command refuses it: review it without taking it.

Work in a checkout of the PR's head branch, checking out the head first when someone else opened it.
When another worktree holds that branch, work in a detached checkout of its head instead, and pass `--branch <head-branch>` to each `quest review` so its rounds continue the branch's session.
Commit everything, then run the repository's local checks and fix any failure the branch causes.
On the head of a PR whose author lacks write access to the repository, run no code from it instead, since it would run with your credentials: leave its checks to CI, and run a `quest` the PR cannot modify, such as an installed release, from outside its checkout with `--root`.
A check failure that reproduces unchanged in a checkout of the base branch is pre-existing rather than the PR's: record the command and both failures in the PR body's validation, go on to review and readiness, and add a follow-up for it unless an open PR already fixes it.
Never alter the repository's harness to get a pass, such as by disabling a tool, unsetting its environment, or skipping a check, nor report an altered run as its checks.

If a `## Review` record that `/quest-merge` counts names the committed head, or its review exemptions cover the changes since the head it names, and it leaves no finding unrefuted, run no new round and go on to pushing and marking it ready below.
If you judge the change too trivial to review, skip the review instead and record the skip and its reason in `## Review`.

Otherwise, review the committed branch with `quest review --base <remote>/<base>`, which picks a reviewer other than the model that changed it last, and its effort, by the PR's size; `quest review --help` explains the round.
It reads the latest implementing model, and on a branch that is not a quest's the size, from the PR body's `## Models` record, so write that record before the first round; a quest branch's size is read from its quest.
Pass `--exclude-model` or `--size` only for a PR whose body cannot hold the record.
Where the repository's root instructions name other reviewers, pass them with `--harness`, `--model`, and `--effort`.
Run it in the foreground; a round takes minutes.
Open the draft PR before the first round: each round rewrites the PR body's `## Review` section with its reviewer, session and round, base and head, score, and each finding's disposition, naming the head's full SHA only once a round reports no findings.
Write a round's record by hand only when it printed `record skipped`, as on another author's fork, and add context only after the record, since the next round rewrites the section.

Fix every finding relevant to the PR in the PR: review findings you do not refute, gaps the change exposes, and bugs in the code it touches.
Never defer a relevant fix to a follow-up just to narrow the PR; add only out-of-scope discoveries as follow-ups.
Refute a finding only with evidence the reviewer cannot rebut: a `path:line`, a command's output, or a recorded maintainer decision.
Commit the fixes, rerun the checks, and run the next round with `--responses`, one response per finding by its number, written in the checkout's `.tmp/`.
Repeat until a round of the head reports no finding you have not refuted; never block on the score.
A finding the reviewer keeps against such a refutation is a decision for the user; a background agent lists it under `## Waiting`.
A round whose findings are all low severity needs no further round: fix or refute each, then add a line after the record naming the new head's full SHA and each finding's disposition.

Checkpoint the design: a round is one `quest review` round, numbered within the branch's review session, and when a round whose number is a multiple of three reports findings, stop before fixing them and reconsider the approach; a clean round needs no checkpoint.
Findings that keep coming usually mean the approach is wrong, not the last fix: brainstorm other designs that would avoid the whole class of findings, favoring simpler ones, and compare them with the current one.
Report the alternatives and what remains, recommending to continue, rethink the approach, merge as is, or drop the PR, and let the user decide; a background agent leaves this under `## Waiting` rather than deciding it.
Record each design change, including a rethink the user picks, in a PR comment that starts with `Design change:`, and start the next review with `quest review --new`, which restarts the count.

A reviewer that is out of quota or logged out is an outage, not a skip: stop reviewing, keep the PR a draft, hand it back, and report the outage.
Its `## Waiting` item names the reviewer, its error, and the check, such as `Codex: out of quota until 2026-11-03 15:00 UTC; check that quest review runs`, with the reset time `quest review` prints when it exits 3 on a usage limit; a logged-out reviewer waits on `Maintainer:`, with the login command `quest review` prints.
Once the reset passes or the login is restored, the item has cleared: whoever finds it runs `/quest-review` on the PR.

Push, then flip the PR to "Ready for Review" with `quest ready <pr> <token>`, which also drops its `## Waiting` section.
For your own draft, mark it ready for review yourself.
Do not wait for online reviewers.

Summarize the review, with its last round's score and rationale, and summarize CI from `quest status <pr>`.
Name any decisions the review raised without answering them, then interactively prompt the user with your recommended action:
- `/quest-merge`: If the PR is landable as `/quest-merge` defines it, or will be once fixed with no decision left for the user, such as failing checks or unaddressed automated review findings; `/quest-merge` runs `/quest-iterate` on it first.
- `/quest-iterate`: If it raised significant issues or decisions, which it settles with the grill skill's interview.
- skip: If the PR should not be merged yet.
- `/quest-delete`: If the quest should be deleted.

While its required checks or automated reviews are still running, report that instead of asking about it; `/quest-complete` asks once they finish.

A background agent that cannot prompt lists these in its report instead.

Hand the PR back with `quest release <pr> <token>` before you ask, report, or go on to `/quest-merge`.
To go straight on to `/quest-iterate` in this session, pass the token to its `quest iterate` instead, which keeps the hold.
