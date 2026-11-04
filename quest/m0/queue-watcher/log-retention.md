# [S] The land daemons prune their own logs

## Goal

`quest land watch` and `quest land serve` delete the logs they wrote to their
state directory once nothing needs them, so a daemon's disk use stays bounded
however long it runs. A log a job still reads, or one an open handback or
removal comment cites, stays until that's done.

## Plan

Decided 2026-11-04 (coordinator, /quest-complete of kixelated/nixos, from
the review of [kixelated/nixos#16](https://github.com/kixelated/nixos/pull/16),
following the maintainer's standing rule to decide follow-ups from
evidence): plan it, [S], m0, in this epic, since the watcher writes most of
these logs and `serve` is retired after it.

Evidence, read on the nixos host on 2026-11-04:

- The daemons' state directories held 1,845 `.log` files and about 4.1 GiB
  (`/var/lib/quest-land-moq` 2.6 GiB, `-moq-pro` 958 MiB, `-rust2` 417 MiB).
  moq's daemon alone wrote 1,202 logs (2.3 GiB) in four days.
- Nothing deletes them. `land-serve.ts` writes `base-`, `check-`, and
  `batch-<time>-<pr>.log`. `land-watch.ts` writes `removal-<pr>-<time>.log`,
  and `land-watch-fix.ts` writes `conflict-` and `fixer-input-` logs, plus the
  fixer job's `<path>.log` read by `land-fixer.ts`.
- [kixelated/nixos#16](https://github.com/kixelated/nixos/pull/16) now counts
  each daemon's state directory against the CI disk quota, so unbounded logs
  will eventually squeeze the merge-queue runners into ENOSPC. Pruning can't
  happen from NixOS, since the same directory holds the daemon's state.

Work:

- Keep a log while a job, fixer run, or pending handback uses it. After
  that, keep it for a fixed window, such as 7 days, so a person can still
  read what a recent comment cites. Delete it after the window.
- Prune on the daemon's existing pass, not a new timer. Only delete files
  matching the names the daemon writes, never other files in the state
  directory.
- Test that a cited or in-use log survives and an old finished one goes.
