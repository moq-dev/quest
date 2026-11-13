---
description: Iterate on an open PR to settle its open decisions, fix CI and review findings, and push.
guide: Format, Creation, Execution, Summaries
skills: grill
---

You own this PR until it is landable.
The argument is the PR; any other text is the user's feedback on it, read against the diff.
Take it with `quest iterate <pr> [token]` before acting, passing a hold token your brief gives or you already have, and keep the token it prints.
If it refuses, stop and report what it printed; taking over a hold is the user's choice.
If you cannot push to the PR's branch, stop and report.
When another worktree holds the PR's branch, work in a detached checkout of its head.
Your `Implementer:` line ends with the size your brief gives the work, as `Implementer: Claude Code, claude-opus-5-5, low effort (iterate, XS)`.

Read the PR, its linked issues and quest, the reviews and comments posted on it, and the surrounding code.
`quest status <pr>` reports its checks, reviews by head, and unresolved threads in one call.
Judge the approach before touching anything: would you take a different one?
`/quest-review`'s design checkpoint counts the rounds of each reviewer's session on the branch, including those earlier agents ran, so it may fall due in this one.
At a `checkpoint` line in `quest status`, an online reviewer's every third round with findings, stop before fixing them and take `/quest-review`'s design checkpoint.

Settle every decision this PR needs with the grill skill's interview, starting from the user's feedback: those its `## Waiting` section lists, those your judgment of the approach or the review findings raise, and any you find along the way.
Record the settled decisions in this PR description's `## Decisions` section as the paper trail, then implement them.
Leave the open decisions of its follow-ups to the round that picks it to merge, and record answers your brief or the user gives as the guide's Creation section describes.

Fix merge conflicts, failing CI checks, and the review findings already posted on the head.
Answer each `signal` line of `quest status <pr>` that your push leaves: reply in the finding's thread, link its review in a comment, or link the decision in a comment saying how the head applies it.
If `quest status <pr>` shows auto-merge enabled, disable it with `gh pr merge <pr> --disable-auto` before any push: GitHub keeps it across a writer's push and would land the new head unreviewed.

Once nothing is unfinished and no decision beyond its follow-ups' needs the user, finish with `/quest-review`, passing your token, whether the PR is a draft or already ready for review: it reviews the branch, pushes, and marks it ready.
If you stop before that on a PR that is ready for review, its new head still needs a review before the push: run `quest review --base <remote>/<base>`, with `--branch <head-branch>` whenever your checked-out branch is not the PR's head branch, and follow each round's `next` line; then push and update the PR's summary.
Hand the PR back with `quest release <pr> <token>`, using the latest token printed, whenever you stop, including to ask.
Never merge; that is `/quest-merge`, once the PR is picked.
