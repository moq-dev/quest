# [S] kix records its follow-up sessions

## Goal

When a kix `iterate` or `merge` job publishes changes to an existing PR,
kix posts or updates one PR comment carrying that session's `Implementer:`
line (harness, model, and effort), so every session that changed the PR is on
record. Whatever reads the PR's implementers reads the PR body's `## Models`
section plus that comment: the `--exclude-model` rule in `/quest-review`,
so a local review never picks a model a kix session coded
with, the [model check](/quest/m1/model-check.md), and
[`quest usage`](/quest/m0/token-waste/usage.md). The PR body and its `## Review` record
stay untouched.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#494](https://github.com/moq-dev/quest/pull/494)). #494 records
each implementing session in the PR body's `## Models` section, and the kix
runner adds its line when a job opens or updates a PR's text. But on an
existing PR, kix `iterate` and `merge` jobs write no PR text (the runner's
`deliver` sends no `pull` for them, `src/runner/job.ts`, so
`cloudflare/src/jobs/publish.ts` never calls `GitHubService.deliver`), and
editing the body would make the App its last editor, which voids the
author's own `## Review` record (`cloudflare/src/github/review.ts`). These
sessions are the second implementers the record exists to catch.

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
- Record a session when it first publishes changes, at a `checkpoint` as
  well as at `deliver`, matching the rule that each session adds its line
  when it first pushes; a merge job that only lands adds none. The runner
  already computes the line for `deliver`, so it can send it with each
  publication and let the Worker post it.
- Readers take the marked comment only when a GitHub App wrote it, since
  any commenter can copy a hidden marker.
- Update `quest/m1/model-check.md` and `quest/m0/token-waste/usage.md` to read the
  comment too, and `quest context`'s `## Models` rule and `/quest-review`'s
  `--exclude-model` rule ("each implementing model the PR body's `## Models`
  records") to name it.
