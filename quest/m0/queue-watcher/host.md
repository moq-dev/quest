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

The watcher command, from
[moq-dev/quest#389](https://github.com/moq-dev/quest/pull/389), run as the
same user and with the same state directory as moq's `quest land serve`
instance, and with `quest` and `flock` on PATH as for it, since the watcher
merges conflicts with the quest merge driver in the same private repository:

```sh
quest land watch --app-id 1039466 --fixer <moq's fixer launcher client>
```

The fixer launcher client is the one `serve --fixer` uses, reaching
`/run/quest-land-fixer.sock` with the failure log and the PR's number. The
watcher needs no check sandbox: the `merge_group` builds run on GitHub's side.
`--fixer-jobs` (default 2) caps the watcher's own fixer jobs below the
launcher's shared slots, and `--fixer-effort` (default `medium`) sets
`QUEST_LAND_FIXER_EFFORT` in the wrapper's environment. The launcher passes
only the log and the PR numbers into the container, where `quest land fix`
defaults to `medium`, so a non-default effort needs the launcher to forward
that variable as `quest land fix --effort`. With a fixer, the watcher's
installation token asks for `merge_queues: write` (re-enqueueing, granted to
moq-bot on 2026-11-02), `contents: write` (arming auto-merge and pushing
fixes), `pull_requests: write`, and `actions: read`, and a push that carries a
workflow change asks for `workflows: write`.

## Related

- [Gate host](/quest/m0/host-land/host.md) - the units and fixer container this reuses
