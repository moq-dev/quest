# [XS] A post-squash tree mismatch comments on the merged PR

## Goal

When GitHub's squash of a landed PR has a different tree from the one the
gate tested, `quest land serve` posts a CRITICAL comment on that merged PR,
naming the squash commit, both trees, and what happened to the rest of the
batch. Today the mismatch reaches only the host's log and warning line, so
nobody reading the PR learns that `main` holds an untested tree.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [XS], m0.

- Raised as a follow-up in
  [moq-dev/quest#321](https://github.com/moq-dev/quest/pull/321), which made
  a post-squash `tree_mismatch` keep the PR merged and the rest of the batch
  queued. The detail is built in `src/cli/land-serve.ts` (`CRITICAL: GitHub
  squash #N at <sha> has tree ...`), then only logged and warned.
- Post it through the daemon's existing comment path, with its marker and
  deduplication, so a restarted daemon doesn't post it twice.
- Extend the post-squash tree-mismatch test in `test/land.test.ts` to expect
  the comment.
