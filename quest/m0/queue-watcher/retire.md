# [M] Retire the batching host gate

## Goal

Once no repository lands through `quest land serve` any more, the batching
gate is gone: `quest land serve`'s batching, parking,
halting, and squash-push code, its tests, and its README and `CONTRIBUTING.md`
sections are deleted, keeping only what the watcher and `quest land apply`
use. The host's `quest land serve` instances and check containers are
removed from kixelated/nixos, while the fixer container and the watcher
instances stay. The unreported `quest land` check and `quest merge --land`'s
pinned auto-merge for it stay, since the watcher's own queue reads its picks
from them.

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
moq.pro is the last: it is private and moq-dev is on GitHub Team, where GitHub
offers merge queues on private repositories only under Enterprise Cloud. On
2026-11-06 the maintainer chose to move it to the watcher's own queue, whose
landing helpers ([moq-dev/quest#540](https://github.com/moq-dev/quest/pull/540))
moved out of serve's files into `src/cli/land-head.ts`, so this deletion
leaves them.
Its `main` ruleset keeps requiring the unreported `quest land` check, which
the own queue relies on so GitHub never merges a pick itself.

## Required

- [moq.pro lands main through the own queue](/quest/m0/queue-watcher/pro-cutover.md) - the last repository leaves the gate
