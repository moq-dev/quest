# [S] The land daemons prune their own logs

## Goal

`quest land watch` and `quest land serve` delete the logs either of them
wrote to their shared state directory once nothing needs them, so a daemon's
disk use stays bounded however long it runs, including after a repository
moves from `serve` to the watcher. A log a job still reads, or one an open handback or
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
- Both daemons share one state directory (`defaultState` in
  `land-serve.ts`), so a repository that moved to the watcher keeps what
  `serve` wrote. moq, rust2 and rind run only the watcher, yet their state
  directories still held 1,140 `base-`, `check-`, `batch-` and
  `fix-job-*.json.log` files (about 311 MiB), last written 2026-11-02. The
  same directories also hold unrelated `.log` files, such as
  `codex-repro-*/failure.log` in subdirectories.
- [kixelated/nixos#16](https://github.com/kixelated/nixos/pull/16) now counts
  each daemon's state directory against the CI disk quota, so unbounded logs
  will eventually squeeze the merge-queue runners into ENOSPC. Pruning can't
  happen from NixOS, since the same directory holds the daemon's state.

Work:

- Keep a log while a job, fixer run, or pending handback uses it. After
  that, keep it for a fixed window, such as 7 days, so a person can still
  read what a recent comment cites. Delete it after the window.
- Prune on the daemon's existing pass, not a new timer. Whichever daemon
  runs prunes every log family either daemon writes, since they share the
  directory: `serve`'s logs left behind by a repository that moved to the
  watcher, and every repository's once `serve` is retired. Judge "in use"
  from every job record in the directory (`fix-job-*`, `fix-base-*` and
  `watch-job-*.json`), whichever daemon wrote it.
- Match exact names, not a `.log` suffix: `base-`, `check-` and
  `batch-<time>-<n>.log`, `removal-<pr>-<time>.log`,
  `conflict-<pr>-<sha>.log`, `fixer-input-<pr>-<time>.log`, and the job
  logs `fix-job-*.json.log`, `fix-base-*.json.log` and
  `watch-job-*.json.log`. Only the state directory's top level, never its
  subdirectories or any other file.
- Test that a cited or in-use log survives, an old finished one goes, an
  expired `serve` log in a watcher's directory goes, and an unrelated
  `.log` file survives.
