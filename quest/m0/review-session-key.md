# [S] Review sessions keyed by upstream branch

## Goal

A `quest review` round run from a local branch that tracks the PR's branch,
such as a temporary branch made because another worktree holds the PR branch,
continues the PR branch's review session, so its round count and design
checkpoint carry over. The iterate and review skills tell agents what to do
when another worktree holds the PR branch.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#474](https://github.com/moq-dev/quest/pull/474)). That day,
iterate agents on #464, #469, #472, and #474 found the PR branch checked out
in another worktree. Each reviewed from a temporary local branch, so
`quest review`, which keys sessions by the checked-out branch name
(`sessionBranch` and `sessionFile` in `src/cli/review.ts`), started a new
session that resets the round-4 design checkpoint, or later resumed the wrong
one.

- What should the quest's goal be?
  - ✅ Key by upstream branch: without `--branch`, the session branch is the
    local branch's upstream branch name when it has one, else its own name.
    The skills say to check out a PR branch another worktree holds detached
    and pass `--branch <pr-branch>`.
  - Rejected: skill guidance only; keying sessions by PR number through the forge
- Which milestone?
  - ✅ m0
  - Rejected: m1; m2

Implementation guidance:

- The upstream's branch name, without the remote, is what matters, so a
  fork's tracking branch keys the same session as the PR's head branch.
- Nothing is in production, so sessions already stored under temporary names
  need no migration.
