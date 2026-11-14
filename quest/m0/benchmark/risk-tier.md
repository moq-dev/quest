# [XS] Read a week of risk tiers before guardrails act on them

## Goal

The maintainer has read at least a week of the risk tiers `quest review`
recorded, against what merged and what later broke, and either trusts them
for [tier guardrails](/quest/m0/benchmark/guardrails.md) or has fixed what
set them wrong: a path in a repository's `RISK.md`, its prose on what is
customer-facing, or the classifier's instructions.

## Plan

`quest review` sets each head's tier since
[#716](https://github.com/moq-dev/quest/pull/716) and records it in the PR
body's `## Review` section. `quest usage --since <date>` shows each PR's
tier and reason, whether a reviewer raised it, and a rollup per tier of
PRs, merges, reviewer raises, and later fixes (`## Caused by`). A tier
reviewers often raise, or a low PR a later one fixed, points at what to
change. A fix lands in this quest's PR; the reading starts over only if
the fix changes most tiers.

A repository with no `RISK.md` records every change medium, so the reading
covers only the repositories that have one.

## Waiting

- Maintainer: read a week of recorded tiers once a release with #716 runs
  on the hosts, and say whether they match your sense of risk; no agent
  can judge that. Check with the tier column and the By risk tier rollup
  of `quest usage --since <date>`.

## Related

- [Development as a benchmark](/quest/m0/benchmark/README.md) - the
  decisions this builds on
- [Breakage](/quest/m0/benchmark/breakage.md) - records what each tier's
  PRs later broke
