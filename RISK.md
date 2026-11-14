# Risk

`quest review` reads this file from the base to set each PR's risk tier, as
the README's Risk tiers section describes.

`quest` runs development in moq-dev's and Kixel's repositories. A merge to
`main` that changes what `scripts/release-plan.sh` ships publishes a
release, which contributors and the maintainer's hosts install. A revert
publishes another, but what agents did under the bad one stays done.

What others rely on here:

- The rules and skills under `assets/`, which every agent session in those
  repositories loads. A change to when an agent may push, merge, post, or
  spend without asking is high.
- The `quest/core` and `quest/github` exports, which Kixel Code imports.
  A change to what they export or return is at least medium, and high when
  it changes how a record or status is read.
- The records `quest` writes into PR bodies and the output of
  `quest status`, `quest usage`, and `quest unblocked`, which skills,
  Kixel Code, and scripts parse.
- The reviewer's sandbox and the credentials `quest` passes to the agents
  it starts, which keep a change from instructing its own reviewer or
  reaching a secret.

Tests, plans under `quest/`, and documentation change nothing others rely
on.

## High

- `assets/CONTEXT.md` - every agent session in every repository using
  Quest loads these rules, including when it may write remotely or merge
- `scripts/installer.sh` - users pipe it to a shell, and a release
  publishes it as it is
- `scripts/release-plan.sh` - it decides which merges publish a release
