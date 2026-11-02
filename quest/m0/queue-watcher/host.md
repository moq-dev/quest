# [S] The host runs the queue watcher for moq-dev/moq

## Goal

The maintainer's NixOS host runs the queue watcher for moq-dev/moq from
[kixelated/nixos](https://github.com/kixelated/nixos), as its own unprivileged
user under a hardened systemd unit like `quest-land.service`, with moq-bot's
key through `LoadCredential` and the same `qland-fix` fixer container and
launcher. Check it by watching it re-enqueue a PR the queue dropped.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan; see the
[epic](/quest/m0/queue-watcher/README.md)): the watcher runs on the host, and
`merge_group` builds run on its self-hosted runner `moq-ci` (label
`moq-queue`, `modules/ci-runners.nix`).

- Add a watcher instance for moq to the quest-land module, and pin a quest
  with the watcher.
- The `quest land serve` instance for moq is disabled at moq's cutover
  (`services.quest-land.repositories.moq.enable = false`), which moq's
  [land quest](https://github.com/moq-dev/moq/blob/main/quest/m0/ci/land.md)
  owns; the fixer container keeps serving the watcher.
- moq-bot may need `actions: read` on moq-dev/moq for the `merge_group` logs;
  the maintainer accepts any new installation permission.
- The runner's own setup and the `merge_group` workflow are moq's switch,
  not this quest.

## Required

- [Fix and re-enqueue](/quest/m0/queue-watcher/fix.md) - the watcher command this deploys

## Related

- [Gate host](/quest/m0/host-land/host.md) - the units and fixer container this reuses
