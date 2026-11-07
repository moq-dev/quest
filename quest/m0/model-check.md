# [S] Model check

## Goal

Once [model routing](/quest/m0/model-routing/README.md) lands, its first
audit checks how the routed PRs went and retunes `quest`'s built-in size
tables, as each milestone's [model check](/quest/m1/model-check.md) does
after it.

## Plan

Recurring, decided 2026-11-04 (user, /quest-plan follow-up of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)): the first
run is in m0 once routing lands, then each milestone.

- This run audits the routing itself, here in m0, following the steps
  [m1's run](/quest/m1/model-check.md) lists, over the PRs merged since the
  routing epic's last quest landed. It skips m1's model id comparison and
  sandbox test, which m0 ran in
  [moq-dev/quest#426](https://github.com/moq-dev/quest/pull/426).
- Review efforts changed 2026-11-05 (user, the
  [token waste](/quest/m0/token-waste/README.md) audit): Sol reviews M at
  medium and L at high, replacing high and xhigh from
  [moq-dev/quest#493](https://github.com/moq-dev/quest/pull/493). xhigh cost
  2-6× more per review, and only 4 large xhigh reviews existed, so nothing
  showed it finds more. Reviews are single-pass since the same change, so
  compare findings per round by effort across the routed PRs, with the
  misses later rounds, CI, or follow-ups found, and recommend restoring a
  higher effort where a lower one misses findings.
- m1's run already exists in [m1](/quest/m1/README.md), requiring m0. The PR that finishes this run creates no new run: it
  carries the tallies and any table changes into m1's Plan as its baseline.

## Required

- [Route quests to models by size](/quest/m0/model-routing/README.md) - the routing, its PR records, and the moq-dev repositories' pins land first
