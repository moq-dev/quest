# [M] Land only reviewed heads

## Goal

kix lands a PR only when the exact head being landed has a review that counts
under the repository's review policy. This covers both an inbox merge and a
merge job's `land` publication. A maintainer's earlier merge pick alone never
lands a head that a runner published or changed since the last review. When
landing waits, kix says why.

## Plan

Decided 2026-10-28 (user, /quest-plan trust audit):

- Today a merge job lands a runner-published head on the maintainer's earlier
  pick, bounded only by branch rules. moq-dev/quest's `main` requires no
  reviews, so nothing enforces the review policy at that point.
- Apply the guide's rule: a review counts only on the head being landed. The
  only exemptions are a conflict-free base merge and a reviewer's patch applied
  unchanged. Where a repository's policy names whose review counts (for
  moq-dev/quest, the PR body's `## Review` record naming the head, in
  `CONTRIBUTING.md`),
  follow it. Otherwise require a review from someone other than the PR's
  author and the App.
- Defer to GitHub branch protection only where it enforces the same
  current-head rule: it requires approval of the most recent push, or it
  dismisses stale approvals. Protection that accepts an approval of an older
  head does not count; keep kix's exact-head check there.
- Test landing with a review of an older head, with a conflict-free base merge
  since the review, with a hand-resolved conflict since the review, with only
  an AI comment from the author's account, and under protection that requires
  reviews without dismissing stale ones.

Decided 2026-10-28 (user, /quest-plan of the follow-ups from
[moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)):

- The PR body's `## Review` record is self-reported: anyone who can edit the
  body can write one. For a head a runner published, kix counts a local
  review only when the runner published its `quest review` result as a
  GitHub App check run on that exact head SHA. Only the App can write one,
  and GitHub binds it to the commit. A maintainer's own `## Review` record
  still counts for the maintainer's PRs.
- Test a body-only `## Review` record on a runner head, which does not count,
  and a check run on an older head.

## Related

- [Web execution](/quest/m0/kix/execution.md) - merge jobs this rule gates
- [Require read-only pull-request CI](/quest/m0/kix/ci-read-only.md) - the trust model this completes
