# [XS] quest wait resolves heads that came from a merge into the branch

## Goal

`quest wait <pr> <sha>` finds when `<sha>` reached the PR's head branch
even when it got there by a merge into the branch, such as GitHub's
**Update branch** or a merge queue's merge, instead of failing with
`cannot resolve push time for <sha>; pass a timestamp with --since`.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from the
2026-11-02 `/quest-complete` session, raised by
[moq-dev/quest#347](https://github.com/moq-dev/quest/pull/347)): ✅ plan it,
m1, since agents merge locally and push, so it's rare, and `--since` works
around it.

- `quest wait`'s setup (`src/cli/wait.ts`) matches the point only among the
  branch's `push`, `force_push` and `branch_creation` activities. Also
  accept `pr_merge` and `merge_queue_merge`, which #347 taught
  `quest status`'s enabled-head lookup to count as moving the head; reuse
  `BRANCH_UPDATES` (`src/cli/status.ts`) rather than keeping a second list.
- Keep reporting force pushes as before: the new activity types only resolve
  the starting point.
