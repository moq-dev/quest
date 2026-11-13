---
description: Queue a PR to land, running /quest-iterate first when it needs work.
guide: Creation, Summaries, Questions
---

Run this in the session that picked the PR, never in a sub-agent of its own: it only decides whether the PR's head can land as is, and queues it.
It never fixes the PR, pushes, or waits on GitHub; a head that needs work goes to `/quest-iterate`, and the merge gate handles conflicts and failures after queueing.

The argument is the PR; without one, it is the current branch's.
It takes no hold, since it never pushes: release one you hold from another skill in this session with `quest release <pr> <token>` first.

Read the PR with one `quest status <pr>`.
If a `hold` record shows another session holds it, stop and report it; taking over a hold is the user's choice.
The head is landable when:

- the PR is not a draft;
- a review counts for it, as below;
- every review finding posted on it, including automated reviewers' such as CodeRabbit or Codex, is fixed on the head or answered with a refutation, and no decision is open;
- no check failed on it, required or not, its required checks passed, other than the gate's own `quest land` check, which never reports on a head, and it does not conflict with its base;
- no review requests changes; an approval its base requires may still be to come, since the queue waits for it.

While its required checks are only pending, report that the pick stands until they pass; do not wait for them.
A change request that stands once its findings are fixed or refuted and their threads resolved is the user's call.
Any other head needs `/quest-iterate`: run it, saying what the head needs, such as a review, fixes, a failed check fixed or rerun, flaky ones included, or decisions, then run this skill again once it finishes; if it stops for the user instead, report that.
Run it in this session, where its interview can ask the user; under a coordinator such as `/quest-run`, return the PR to the loop, which dispatches it in a sub-agent.
A PR that adds follow-ups also needs the pick round's answers recorded before queueing, as the guide's Creation section describes: ask about each follow-up that round has not asked, in a question of its own, then run `/quest-iterate` with the answers unless the head already records them.

A review counts for the head its `## Review` record names: a local `quest review` round, or a recorded skip.
Read `quest status <pr>`'s `review-record` line rather than comparing diffs yourself: `current` or `diff-identical` (the head's diff from the base is unchanged since the reviewed head) counts.
Otherwise, the changes since the reviewed head need no new review only when they are conflict-free merges from the base branch, a reviewer's suggested patch applied unchanged, the fixes of a round whose findings were all low severity, a land fixer's recorded mechanical fix that changes no behavior, or the pick round's answers recorded in the PR's follow-ups.
The repository's review policy decides whose record counts and may require more, such as a maintainer's review.
Where it says nothing, only a record on a PR whose author has write access counts: anyone else writes their own PR body, so their head needs a local review that rewrites the record.

Queue the head with `quest merge <pr> --land <full 40-character head SHA>`, adding `--squash` or `--rebase` when the repository's root instructions name that method for the PR's base.
Run a `quest` the PR cannot modify, such as an installed release rather than a build from the head's checkout: it refuses a head that leaves its quest inaccurate, a check the head's own code could skip.
A refusal says what the head or the repository needs: follow it, sending a head that needs a fix or its base merged to `/quest-iterate`.
Ask instead when it refuses a head `/quest-iterate` left unchanged, and never pass `--direct` unless the user explicitly asks.

Report once it is queued, and do not wait for it to merge.
A PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`; it needs the user's pick again, except where `/quest-run` says an earlier pick still holds.
Never close a PR to unstick it, and never work around a refused merge; ask instead.
