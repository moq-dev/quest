# [XS] Fixer priority and rerere on the land host

## Goal

The fixer stops slowing the batch check, and the gate stops paying twice for
a conflict it has already seen:

- Fixer containers run below the batch check's CPU and IO priority on the
  land host, so checks under load stop timing out.
- The gate's repository enables `git rerere`, so it replays conflict
  resolutions it has already made, if a measurement shows it can.

## Plan

Decided 2026-11-01 (maintainer, from the audit of the merge-queue plan; see
the [epic](/quest/m0/land-fixer/README.md)). What landed of the original
quest:

- Batch size from the measured failure rate, and a base-PR conflict that
  parks the PR and fills the batch in the same round:
  [moq-dev/quest#376](https://github.com/moq-dev/quest/pull/376).
- The fixer's explicit `medium` reasoning effort:
  [moq-dev/quest#370](https://github.com/moq-dev/quest/pull/370).
- The fixer cap: the host's `quest-land-fixer.socket` accepts at most three
  fixer containers across every gate
  ([kixelated/nixos@aa155d1](https://github.com/kixelated/nixos/commit/aa155d1)).

Remaining:

- Priority is host configuration in
  [kixelated/nixos#16](https://github.com/kixelated/nixos/pull/16)
  (`modules/quest-land.nix`). As of 2026-11-01 neither
  `quest-land-fixer@.service` nor the `quest-land-*-check@.service` units set
  `CPUWeight` or `IOWeight`; both run at the default 100 in `ci.slice`. Give
  the fixer unit a lower weight, such as `CPUWeight=20` and `IOWeight=20`.
  Check with `systemctl show quest-land-fixer@<instance> -p CPUWeight`.
- rerere: open question. On moq-dev/moq from 2026-10-30 to 11-01, 43 of the
  89 PRs that conflicted with the base conflicted more than once, but only 20
  of the 96 repeats named the same files as the PR's previous conflict. The
  gate never resolves a conflict itself: `squash` in `src/cli/land.ts` resets
  on any conflict, and the fixer resolves in a fresh container clone, so the
  gate's `rr-cache` would stay empty. Replaying would mean training rerere
  from the fixer's pushed merges and letting the gate's own squashes apply
  them, which lands a resolution the PR's head never had. Recommended: drop
  this item and delete the quest once priority lands.
