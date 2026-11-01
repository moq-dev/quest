# [S] The fixer comments on GitHub

## Goal

The fixer can post and edit comments on the batch's PRs, for example to
explain a fix, a disabled flaky test, or the decision it needs. It does this
with a GitHub token limited to issue and PR comments on that one repository,
which the daemon mints for each job and which expires with it. The token
cannot push, merge, change labels, or reach any other repository.

## Plan

Decided 2026-11-01 (user, /quest-plan): "It's also allowed to comment on
Github." See the [epic](/quest/m0/land-fixer/README.md).

- How the fixer gets to comment:
  - The daemon posts the comments the fixer writes into its result, so no
    GitHub credential enters the container (recommended, because PR code the
    fixer builds can read the container's environment, as
    [moq-dev/quest#356](https://github.com/moq-dev/quest/pull/356) found for
    the proxy key)
  - ✅ A comment-only token in the container
  - Both

Mint an installation token for the job's repository with
`permissions: { issues: "write" }`, which covers PR conversation comments, and
`repositories: [<repo>]`. Pass it to the agent as `GH_TOKEN` only; the wrapper
keeps every other credential out, as today. GitHub caps a token at one hour,
so a longer job gets a fresh one or stops commenting. The daemon keeps posting
its own requeue and handback comments.

## Related

- [Fixer starts from main](/quest/m0/land-fixer/launch.md) - what the fixer sees when it starts
