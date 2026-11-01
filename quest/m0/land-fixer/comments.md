# [S] The fixer comments on GitHub through the daemon

## Goal

The fixer can explain its work on the batch's PRs (a fix, a rerun-proven
flaky test, or the decision it needs) by writing comments into its result:
each has a target PR number from its job and a Markdown body, at most one per
PR, with a size cap. When it collects the job, the daemon validates and posts
them. It redacts tokens, strips hidden markers so the fixer's text cannot
pose as the daemon's or the fixer's own, and drops any comment aimed at a PR
outside the job. No GitHub credential enters the fixer container.

## Plan

Decided 2026-11-01 (user, /quest-plan): "It's also allowed to comment on
Github." See the [epic](/quest/m0/land-fixer/README.md).

- How the fixer gets to comment, first round:
  - The daemon posts the comments the fixer writes into its result
  - A comment-only token in the container (picked)
  - Both
- GitHub has no comment-only permission, so the token was `issues: write`
  (picked: accept it).
- Reversed the same day after an independent audit, because PR code the fixer
  builds can read the container's environment and post as moq-bot[bot]. Three
  things trust moq-bot comments: `quest land apply` reads a bot comment that
  carries the fixer's marker, the daemon skips a post when its own marker is
  already there, and `quest status` reads the gate's hidden ejection reason.
  - ✅ The daemon posts them from the fixer's result
  - Keep the token in the container

Implemented in [moq-dev/quest#367](https://github.com/moq-dev/quest/pull/367),
which is being reworked to this design. The daemon keeps posting its own
requeue and handback comments.

## Related

- [Fork commits](/quest/m0/land-fixer/fork-commit.md) - trusts the fixer's bot comment marker
