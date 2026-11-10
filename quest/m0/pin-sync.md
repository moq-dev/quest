# [S] Hosts run quest's pin bumps and upgrade on their own

## Goal

Every push to moq-dev/quest's `main` reaches each repository that pins quest,
and each host, without a person or an agent touching it: the quest watcher on
the maintainer's host runs `quest land watch --bump` for every such
repository, kixelated/nixos included, and each host applies kixelated/nixos's
`main` through `system.autoUpgrade`, so the queue watchers run the quest
`main` has within the hour.

## Plan

The bump pass itself is done (README, "Pin bumps"). What remains is the host
configuration in kixelated/nixos, drafted on its `quest-pin-sync` branch:

- `modules/quest-land.nix` passes `--bump` to the quest watcher for every other
  land repository plus moq-dev/studio, moq-dev/kixel.ai, and kixelated/nixos,
  and puts Nix on its `PATH`.
- `modules/base.nix` enables `system.autoUpgrade` hourly on the host from
  `git+ssh://git@github.com/kixelated/nixos?ref=main#<host>`, fetched with
  the host's SSH host key as a read-only deploy key.
- Check and fixer containers already survive a switch
  (`restartIfChanged = false`), and a watcher's detached fixer supervisor
  outlives its daemon's restart. The batching gate stops its check with it, so
  it is not restarted by a switch until moq.pro moves onto the watcher
  ([moq.pro cutover](/quest/m0/queue-watcher/pro-cutover.md)).

Once the bump pass is on quest's `main`, bump that branch's quest input to it
(the watcher rejects `--bump` before then), land it, and switch the host by
hand once; from then on it upgrades itself.

Decided 2026-11-10 (maintainer, /quest-unblock): nixos2 is retired (it now
runs Windows), so only nixos needs a deploy key. Done the same day: nixos's
`/etc/ssh/ssh_host_ed25519_key.pub` is kixelated/nixos's read-only deploy key
"nixos host (nixos-upgrade)", and `sudo ssh -i /etc/ssh/ssh_host_ed25519_key
git@github.com` on nixos authenticates as kixelated/nixos. Drop nixos2 from
the `quest-pin-sync` branch's `system.autoUpgrade` hosts.

## Waiting

- Maintainer: install moq-bot on the kixelated account for kixelated/nixos,
  with the permissions it has on moq-dev, since an App installation needs the
  account owner's consent; check that the quest watcher's journal shows
  `bump kixelated/nixos` rather than a failed token request.

## Related

- [Land through the merge queue](/quest/m0/queue-watcher/README.md) - the host daemon this builds on
