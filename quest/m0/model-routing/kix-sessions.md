# [S] kix records its follow-up sessions

## Goal

When a kix `iterate` or `merge` job delivers on an existing PR, kix posts or
updates one PR comment carrying that session's `Implementer:` line (harness,
model, and effort), so every session that changed the PR is on record. The
[model check](/quest/m1/model-check.md) and [`quest usage`](/quest/m1/usage.md)
read the PR body's `## Models` section plus that comment. The PR body and its
`## Review` record stay untouched.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#494](https://github.com/moq-dev/quest/pull/494)). #494 records
each implementing session in the PR body's `## Models` section, and the kix
runner adds its line when a job opens or updates a PR's text. But on an
existing PR, kix `iterate` and `merge` jobs write no PR text
(`cloudflare/src/jobs/publish.ts`, `GitHubService.deliver`), and editing the
body would make the App its last editor, which voids the author's own
`## Review` record (`cloudflare/src/github/review.ts`). These sessions are
the second implementers the record exists to catch.

- How should those sessions be recorded?
  - ✅ A kix PR comment that the audits also read
  - Rejected: editing only the body's `## Models` section and exempting such
    edits from the review-record check; leaving them unrecorded
- Which milestone?
  - ✅ m0, in this epic beside the record it completes
  - Rejected: m1

Implementation guidance:

- One comment per PR, found by a hidden marker and updated in place, with
  one `Implementer:` line per session in the `## Models` line format.
- Update `quest/m1/model-check.md` and `quest/m1/usage.md` to read the
  comment too, and `quest context`'s `## Models` rule to mention it.

## Required

- [Commits and PRs record their models](/quest/m0/model-routing/implementer.md) - this builds on its `## Models` record and the runner's reporting
