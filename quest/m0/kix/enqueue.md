# [S] kix enqueues ready PRs into the merge queue

## Goal

On a base with a merge queue, kix's Worker enqueues a PR whose head it
lands with `enqueuePullRequest` pinned to that head as soon as GitHub can
queue it, instead of only arming auto-merge, so kix-landed PRs reach the
queue even when GitHub fails to move auto-merge PRs into it. While required
checks are still pending, kix keeps arming auto-merge bound to the head, as
`quest merge --land` does.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from the
2026-11-02 `/quest-complete` session, raised by
[moq-dev/quest#385](https://github.com/moq-dev/quest/pull/385)): ✅ plan it,
m0.

- `landPullRequest` (`cloudflare/src/github/service.ts`) lands a merge-queue
  base only by arming auto-merge. Since about 2026-09-10, GitHub often never
  moves such PRs into the queue
  ([community#209348](https://github.com/orgs/community/discussions/209348)).
- Share the CLI's split from #385 (`land` in `src/cli/hold.ts`): enqueue
  with `expectedHeadOid` when the PR is ready, arm auto-merge when checks may
  be pending, and fall back to enqueueing when GitHub answers that the PR is
  already in clean status. Move the decision into shared code if both sides
  can call it, rather than keeping two copies.
- A refused enqueue (conflict, failing checks) is a job result the runner
  reports, like any other refused landing; kix doesn't fix it.
- The [land review](/quest/m0/kix/land-review.md) rule still applies first:
  kix enqueues only a head with a review that counts on it.

## Required

- [Land review](/quest/m0/kix/land-review.md) - rewrites the same `landPullRequest`, in [moq-dev/quest#351](https://github.com/moq-dev/quest/pull/351)
