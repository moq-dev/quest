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
Keep `serve`'s log names (`base-`, `check-`, `batch-`, `fix-job-` and
`fix-base-`) in the watcher's log pruning, so the logs `serve` left in the
shared state directory still expire.

moq, moq-dev/quest, rind and rust2 land through the merge queue (2026-11-03).
moq.pro is the last: on 2026-11-02 the maintainer kept it on its host gate,
and its `main` ruleset still requires `quest land`. moq.pro is private and
moq-dev is on GitHub Team, where GitHub has offered merge queues on private
repositories only under Enterprise Cloud.

## Waiting

- Maintainer: decide how moq.pro leaves the host gate, since only the
  maintainer can change moq-dev's plan or repository settings. Options:
  enable a merge queue in moq.pro's `main` ruleset if GitHub now offers one
  there (recommended; check the ruleset editor first); move moq-dev to
  Enterprise Cloud for it; or keep moq.pro on the gate and delete this
  quest. Check with
  `gh api repos/moq-dev/moq.pro/rulesets/16788924 --jq '[.rules[].type]'`,
  which lists `merge_queue` once it is enabled.

## Required

- [The other repositories follow](/quest/m0/queue-watcher/follow.md) - the last repositories leave the gate
