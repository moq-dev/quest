# [S] Count policy-named review records when landing

## Goal

kix's land gate (`cloudflare/src/github/review.ts`) also counts the review a
repository's policy names beyond GitHub approvals and the App's `quest review`
check run: a `## Review` record in the PR body naming the exact head being
landed, on a PR whose author has write access, at a head no runner published.
Under moq-dev/quest's `CONTRIBUTING.md`, that record is what counts for a
maintainer's own PRs.

## Plan

Decided 2026-10-28 (user, /quest-plan trust audit):

- Apply the guide's rule: a review counts only on the head being landed. Where
  a repository's policy names whose review counts (for moq-dev/quest, the PR
  body's `## Review` record naming the head, in `CONTRIBUTING.md`), follow it.
  Otherwise require a review from someone other than the PR's author and the
  App.

Decided 2026-10-28 (user, /quest-plan of the follow-ups from
[moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)):

- The PR body's `## Review` record is self-reported: anyone who can edit the
  body can write one. For a head a runner published, kix counts a local
  review only when the runner published its `quest review` result as a
  GitHub App check run on that exact head SHA. A maintainer's own `## Review`
  record still counts for the maintainer's PRs.
- Test a body-only `## Review` record on a runner head, which does not count.

Done in [moq-dev/quest#351](https://github.com/moq-dev/quest/pull/351): both
an inbox merge and a merge job's landing require an approval on the exact head
by a writer other than the author, or the App's passing `quest review` check
run on it, carried across verified conflict-free merges of the default branch,
and defer to rulesets that enforce current-head approval. No `## Review` record
counts yet.

Open:

- How kix learns which repositories' policies count the record: every
  enrolled repository, since the guide each adopts makes it the default; a
  declaration on the default branch; or a per-project setting.
- How kix tells a runner-published head: kix publishes commits without an
  author or committer, so GitHub attributes them to the App.

## Related

- [Web execution](/quest/m0/kix/execution.md) - merge jobs this rule gates
- [Require read-only pull-request CI](/quest/m0/kix/ci-read-only.md) - the trust model this completes
