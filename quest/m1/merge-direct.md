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
`land` (`src/cli/hold.ts`), `immediateMerge` is false for `UNKNOWN`, so it
submits `enablePullRequestAutoMerge`. `cleanAutoMergeRefusal` matches only
GitHub's "pull request is in clean status" refusal, so the error is thrown.
The PR landed by hand with `gh pr merge --squash --match-head-commit`.

Decided 2026-11-10 (user, /quest-plan): ✅ m1 (rejected: m0, drop), since
moq-dev's repositories land through merge queues or `quest land` and never
take `--direct`.

Recommended: when `--direct` let the call past the auto-merge check, submit
`mergePullRequest` with `expectedHeadOid` without trying auto-merge. GitHub
refuses a merge that the PR's state does not allow, so nothing is lost by
skipping the wait. A head with failing checks is already refused earlier by
`passing`. Pending required checks on such a repository can only be waited
for by the caller, since there is no auto-merge to wait for them; say so in the
`--direct` help. Cover the `UNKNOWN` case in the `land` tests.
