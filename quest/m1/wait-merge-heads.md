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
  accept `pr_merge` and `merge_queue_merge` when resolving the point, the
  types #347 taught `quest status`'s enabled-head lookup to count as moving
  the head. Export `BRANCH_UPDATES` from `src/cli/status.ts`, or move it to a
  module both import, rather than keeping a second list.
- Use that merge-inclusive list only to find the starting point. The pushes
  `quest wait` reports keep using the existing push list, so a merge into the
  branch is never reported as `pushed`, and force pushes print as before.
