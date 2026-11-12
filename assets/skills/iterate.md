---
description: Iterate on an open PR to settle its open decisions, fix CI and review findings, and push.
guide: Format, Creation, Execution, Summaries
skills: grill
---

You own this PR until it is landable.
Parse the arguments to determine the PR number. Any other text is the user's feedback on the PR; interpret it against the diff.
Take it with `quest iterate <pr>` before acting, passing a token you already hold for it to keep that hold, and keep the hold token it prints; `quest iterate --help` explains holds.
If it refuses because another session holds the PR, stop and report what it printed; taking over a stale hold is the user's choice.
If you cannot push to the PR's branch, stop and report.
Your `Implementer:` line ends with the size your brief gives the work, as `Implementer: Claude Code, claude-opus-5-5, low effort (iterate, XS)`.

Read the PR, its linked issues and quest, the reviews and comments posted on it, and the surrounding code.
`quest status <pr>` reports its checks, reviews by head, and unresolved threads in one call.
Judge the approach before touching anything: would you take a different one?
`/quest-review`'s design checkpoint counts the rounds of each reviewer's session on the branch, including those earlier agents ran, so it may fall due in this one.

Settle every decision this PR needs with the grill skill's interview, starting from the user's feedback: those its `## Waiting` section lists, those your judgment of the approach or the review findings raise, and any you find along the way.
Record the settled decisions in this PR description's `## Decisions` section as the paper trail, then implement them.
Leave the open decisions of its follow-ups to the round that picks it to merge, and record answers your brief or the user gives as the guide's Creation section describes.

Fix merge conflicts, failing CI checks, and the review findings already posted on the head.
Answer each `signal` line of `quest status <pr>` that your push leaves: reply in the finding's thread, link its review in a comment, or link the decision in a comment saying how the head applies it.

If `quest status <pr>` shows auto-merge enabled, disable it with `gh pr merge <pr> --disable-auto` before any push: GitHub keeps it across a writer's push and would land the new head unreviewed.
Once nothing is unfinished and no decisions beyond its follow-ups' need the user, run `/quest-review` with your token, which reviews the branch, pushes, and marks the PR ready.
Otherwise, before pushing to a PR that is ready for review, review the new head locally with `quest review --base <remote>/<base>`, following each round's `next` line; when another worktree holds the PR branch, work in a detached checkout of its head and pass `--branch <head-branch>`; then push and update the PR's summary.
Summarize the changes made.
Hand it back with `quest release <pr> <token>`, using the latest token printed, whenever you stop, including to ask.
Never merge; that is `/quest-merge`, once the PR is picked.
