# [S] The fixer comments on GitHub

## Goal

The fixer can post and edit comments on the batch's PRs, for example to
explain a fix, a disabled flaky test, or the decision it needs. It does this
with a GitHub installation token for that one repository with only
`issues: write`, which the daemon mints for each job and which expires with
it. The token cannot push code, merge, or reach any other repository. As the
maintainer accepted, it can also edit or close issues and change labels in
that repository.

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

- GitHub has no comment-only permission; `issues: write` also allows editing
  and closing issues and changing labels, and PR code the fixer builds could
  read the token (Codex review of this plan):
  - A local comment command: the daemon keeps the credential and exposes
    only comment operations inside the container (recommended)
  - ✅ Accept `issues: write` in the container
  - The daemon posts comments from the result

Mint an installation token for the job's repository with
`permissions: { issues: "write" }`, which covers PR conversation comments, and
`repositories: [<repo>]`. Pass it to the agent as `GH_TOKEN` only; the wrapper
keeps every other credential out, as today. GitHub caps a token at one hour,
so a longer job gets a fresh one or stops commenting. The daemon keeps posting
its own requeue and handback comments.

## Related

- [Fixer starts from main](/quest/m0/land-fixer/launch.md) - what the fixer sees when it starts
