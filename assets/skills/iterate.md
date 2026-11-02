---
description: Iterate on an open PR to settle its open decisions, fix CI and review findings, and push.
---

Before you begin, run `quest guide` and `quest skill grill`, and read their output completely.

You own this PR until it is landable.
Parse the arguments to determine the PR number. Any other text is the user's feedback on the PR; interpret it against the diff.
Take it with `quest iterate <pr>` before acting, passing a token you already hold for it to keep that hold, and keep the hold token it prints; `quest iterate --help` explains holds.
If it refuses because another session holds the PR, stop and report what it printed; taking over a stale hold is the user's choice.
If you cannot push to the PR's branch, stop and report.

Read the PR, its linked issues and quest, the reviews and comments posted on it, and the surrounding code.
`quest status <pr>` reports its checks, reviews by head, and unresolved threads in one call.
Judge the approach before touching anything: would you take a different one?
Follow the guide's Reviews section for the shared design checkpoint across review rounds.

Settle every decision this PR needs with the grill skill's interview, starting from the user's feedback: those its `## Decisions needed` section lists, those your judgment of the approach or the review findings raise, and any you find along the way.
Record the settled decisions in this PR's description as the paper trail, then implement them.
A sub-agent that cannot prompt leaves each in `## Decisions needed` with a recommendation.

Fix merge conflicts and failing CI checks.
Address the automated review findings already posted, without waiting on optional reviewers: fix those you agree with and comment on any you decline.
One round only; never request a review, including by toggling a ready PR to draft and back.

Before pushing to a PR that is ready for review, review the new head locally as the guide's Reviews section describes.
If `quest status <pr>` shows auto-merge enabled, disable it with `gh pr merge <pr> --disable-auto` before any push: GitHub keeps it across a writer's push and would land the new head unreviewed.
Push your changes to the PR and update its summary.
Summarize the changes made.

Once nothing is unfinished and no decisions need the user, run `/quest-review` with your token, which reviews the branch, pushes, and marks the PR ready.
Hand it back with `quest release <pr> <token>`, using the latest token printed, whenever you stop, including to ask.
Never merge; that is `/quest-merge`, once the user picks it.
