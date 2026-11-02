# [M] The other repositories follow moq to the merge queue

## Goal

Condition: the maintainer judges moq-dev/moq's merge queue and watcher
proven, from the live evidence moq's
[land quest](https://github.com/moq-dev/moq/blob/main/quest/m0/ci/land.md)
collects. Ask the maintainer once the watcher has run on moq.

Then moq-dev/quest lands through GitHub's merge queue with the watcher: a
`merge_group` workflow runs `just check` and `just test`, `main`'s ruleset
requires it and the merge queue instead of the unreported `quest land`
check, the host's `quest land serve` instance for quest is disabled, and a
watcher instance serves it. A PR from a fork lands through the queue.
`CONTRIBUTING.md` and the README's landing section describe it. moq.pro, rust2
and rind each plan their own switch in their trees.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)):

- ✅ moq first; moq-dev/quest, moq.pro, rust2 and rind stay on the host
  `quest land` gate until moq proves it, then follow.

This absorbs the fork-path verification that remained of "moq-dev/quest
lands through quest land" (decided 2026-10-26 and 2026-10-27, user): the
host gate's fork path was never verified live. On the merge queue, GitHub
lands a fork PR itself; verify one live, and fix anything it needs here.

moq.pro is private, and moq-dev is on GitHub Team. GitHub has offered merge
queues on private repositories only under Enterprise Cloud, so check whether
moq.pro can enable one before planning its switch; if it can't, it stays on
the host gate, and [Retire the batching gate](/quest/m0/queue-watcher/retire.md)
needs a maintainer decision. moq-dev/quest, rust2 and rind are public.

## Required

- [Watcher on the host](/quest/m0/queue-watcher/host.md) - moq's watcher runs, so its queue can be proven
