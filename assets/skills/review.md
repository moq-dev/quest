---
description: Review a PR's branch locally with the other vendor's model, then mark it ready for review.
---

Before you begin, run `quest guide` and `quest skill merge`, and read their output completely.

Parse the arguments to determine the PR number, otherwise resolve it from the current context/branch.
If its body lists open decisions or unfinished work, offer `/quest-iterate` first.

Take the PR with `quest ready <pr>`, passing a token you already hold from another state to swap it, and keep the hold token it prints; `quest ready --help` explains holds.
If it refuses because another session holds the PR, stop and report what it printed; taking over a stale hold is the user's choice.
A draft you started in this session has no `## Decisions needed` section, so it is still yours and the command refuses it: review it without taking it, and take it once you have marked it ready below.

Work in a checkout of the PR's head branch, checking out the head first when someone else opened it.
Commit everything, then run the repository's local checks, unless the guide's Reviews section says to run no code from the head, and fix any failure.

Review the committed branch with `quest review`, as the guide's Reviews section describes; `quest review --help` explains the round.
Run it in the foreground; a round takes minutes.
Fix each finding you agree with, or refute it with evidence the reviewer can check.
Commit the fixes, rerun the checks, and run the next round with `--responses`, one response per finding, written in the checkout's `.tmp/`.
Repeat until a round of the head reports no finding you have not refuted with evidence.
A finding the reviewer keeps against such a refutation is a decision for the user; a background agent lists it under `## Decisions needed`.
If you judge the change too trivial to review, skip the review instead and record why.

Rewrite the PR body's `## Review` section after each round, or once for a skip.
Push, then flip the PR to "Ready for Review" with `quest ready <pr> <token> --done`, which also drops its `## Decisions needed` section.
For your own draft, mark it ready for review yourself, then take it with `quest ready <pr>`.
Do not wait for online reviewers.

Summarize the review and CI from `quest status <pr>`, then interactively prompt the user with your recommendation:
- `/quest-merge`: If the PR is landable as `/quest-merge` defines it, which needs its required status checks passed and every automated review finding on GitHub fixed or refuted.
- `/quest-iterate`: If it raised significant issues or decisions.
- skip: If the PR should not be merged yet.
- `/quest-delete`: If the quest should be deleted.

While its required checks or automated reviews are still running, report that instead of asking about it; `/quest-complete` asks once they finish.

A background agent that cannot prompt lists these in its report instead.

Hand the PR back with `quest release <pr> <token>` before you ask or report.
To go straight on to `/quest-iterate` or `/quest-merge` in this session, pass the token to its command instead, which swaps the label.
