# [L] Repositories and hosts follow quest's main

## Goal

Every push to moq-dev/quest's `main` reaches each enrolled repository and
each host without a person or an agent touching it. The maintainer's host
opens or updates one pin-bump PR per repository, as moq-bot, and queues it.
kixelated/nixos is a target too, and its hosts apply its `main` on their
own, so the queue watcher and gate run the same quest within the hour.

## Plan

Decided 2026-11-05 (user, /quest-plan, after the
[token waste](/quest/m0/token-waste/README.md) plan merged): "it's kind of
annoying to need to update every PR and repo."

Measured that day: moq-dev/moq, studio, and rind pinned quest at
`4be3508`, rust2 at `dc8008b`, kixel.ai at `5790eea`, and kixelated/nixos at
`91714ab`; moq.pro and quest itself track `main` through their lockfiles. Each
dev shell puts its pinned `quest` first on `PATH`, so a skill or rule change
reaches a repository's agents only after a bump PR there. The NixOS hosts
change only on a manual `nixos-rebuild switch`. Machines' dotfiles now pull
themselves hourly ([kixelated/dotfiles#42](https://github.com/kixelated/dotfiles/pull/42)),
so this quest covers only the repositories and hosts.

Decision prompts, chosen options marked ✅:

- How updates reach repositories: ✅ the host bot bumps (rejected:
  Dependabot with auto-merge, which lags a day and needs a write token in
  each repository's workflows; unpinning agent content to a user-level
  `quest`, which lets two versions disagree on the format). The nixos host
  already holds moq-bot's App credentials and the enrolled repositories.
- Review of a bump PR: ✅ the bot records a `## Review` skip, since a pin
  bump changes no repository code and each repository's CI, running
  `quest check` with the new quest, is the gate (rejected: a Codex round per
  bump).
- A format change: ✅ the bot runs `quest check --fix` with the new quest and
  commits the result in the bump PR; a finding `--fix` cannot resolve leaves
  the PR open with a `## Waiting` item (rejected: hand the failing PR to an
  agent).
- Cadence: ✅ every push to `main`, updating the one open bump PR per
  repository so several merges coalesce (rejected: tagged releases only).
- Hosts: ✅ kixelated/nixos is a bump target, and each host enables
  `system.autoUpgrade` from its `main` (rejected: bump with manual deploys;
  leave the hosts).

Recommendations for the implementer:

- Pin every repository the same way, a branch URL with the revision only in
  `flake.lock`, so a bump is one `nix flake update` of the quest input.
- Reuse the queue watcher's App client, enrolled-repository list, and
  enqueue path rather than a second daemon's.
- The kixelated/nixos half (the bump target and `system.autoUpgrade`) is a
  PR there; check that an upgrade does not restart the queue watcher in the
  middle of a fixer job.

## Related

- [Land through the merge queue](/quest/m0/queue-watcher/README.md) - the host daemon this builds on
