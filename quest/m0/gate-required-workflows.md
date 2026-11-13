# [S] Gate counts required workflows

## Goal

The gate's check matching (`checks()` in `src/cli/land.ts`) counts the base's required workflows (ruleset `workflows` rules) the same way `quest status` and `quest wait` do, so the gate never lands a head whose required workflow never ran or has not passed.

## Plan

- Settled on [moq-dev/quest#674](https://github.com/moq-dev/quest/pull/674): keep this as its own quest in m0, since it is the same disagreement between readers that #674 fixes for status and wait.
- Reuse the shared `requiredOf` and `unreported` from `src/cli/status.ts`: a job in a required workflow counts as required, and a required workflow path nothing reports keeps the PR waiting rather than landing.
- Test the gate with a base whose ruleset requires a workflow that has not run on the head.
