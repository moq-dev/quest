# [M] Retire the batching host gate

## Goal

Once no repository lands through `quest land serve` any more, the batching
gate is gone: `quest land serve`'s batching, parking,
halting, and squash-push code, its tests, and its README and `CONTRIBUTING.md`
sections are deleted, keeping only what the watcher and `quest land apply`
use. The host's `quest-land` daemon instances and check containers are
removed from kixelated/nixos, while the fixer container stays. Nothing still
requires the unreported `quest land` check, and `quest merge --land` no longer
special-cases it.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)): the merge queue replaces the
batched gate, and gate work is frozen until then. Once nothing uses it, the
code goes rather than staying as an unmaintained option. Check each
repository's ruleset for a `quest land` requirement before deleting.

## Waiting

- moq.pro, rust2, rind: each lands through the merge queue instead of
  `quest land serve`, as moq and moq-dev/quest will after
  [the other repositories follow](/quest/m0/queue-watcher/follow.md). Check
  each repository's ruleset for a `quest land` requirement.

## Required

- [The other repositories follow](/quest/m0/queue-watcher/follow.md) - the last repositories leave the gate
