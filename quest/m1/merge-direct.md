# [S] Direct merges never arm auto-merge

## Goal

On a repository with auto-merge disabled, `quest merge <pr> --land <sha>
--direct` lands a landable head as a direct merge pinned to that SHA,
including while GitHub still reports the PR's merge state as `UNKNOWN`, as it
does just after a push. It never tries `enablePullRequestAutoMerge` there.
Without `--direct`, the refusal on such a repository is unchanged.

## Plan

Found 2026-11-10 landing
[kixelated/nixos#46](https://github.com/kixelated/nixos/pull/46), a private
repository on GitHub Free with auto-merge off. Seconds after a base merge was
pushed, `quest merge 46 --land 74718b1… --direct --squash` failed with
`GitHub GraphQL error: Auto merge is not allowed for this repository`. In
`land` (`src/cli/hold.ts`), `--direct` only skips the `allow_auto_merge`
refusal. `immediateMerge` (`src/github/merge.ts`) is false for `UNKNOWN`, so
`land` submits `enablePullRequestAutoMerge`, and `cleanAutoMergeRefusal`
matches only GitHub's "pull request is in clean status" refusal, so the error
is thrown. The PR landed by hand with
`gh pr merge --squash --match-head-commit`.
The bump daemon's `settle` (`src/cli/land-bump.ts`) passes `direct` on an
ungated base without auto-merge once every check passed, and hits the same
error whenever GitHub has not yet computed the state.

Decided 2026-11-10 (user, /quest-plan): ✅ m1 (rejected: m0, drop), since
moq-dev's repositories land through merge queues or `quest land` and never
take `--direct`.

Recommended: on the ungated path of `land`, try auto-merge only when the
repository's `allow_auto_merge` is `true`, which the refusal already requires
without `--direct`; otherwise submit `mergePullRequest` with
`expectedHeadOid` at once. A repository that allows auto-merge keeps today's
behavior with or without `--direct`.
A direct merge waits for nothing: `passing` already refuses a failing check,
and GitHub refuses a merge its rules forbid this token, but a pending or
absent check does not block, as `quest merge --help` says, and a token that
can bypass the base's rules merges past pending required checks too. Say in
the `--direct` help that the caller waits for checks before landing, as
`settle` does.
In `test/hold.test.ts`, cover `--direct` with auto-merge off in `UNKNOWN` and
`BLOCKED`, merging without an auto-merge request; the existing "preserves a
refused UNKNOWN auto-merge" cases stay, since their repository allows
auto-merge.
