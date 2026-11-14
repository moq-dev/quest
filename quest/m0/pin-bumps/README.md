# [S] Every merge reaches every repository that pins quest

## Goal

A merge to quest's `main` that changes what ships becomes a release, and within the hour
every other repository with moq-bot installed whose flake locks quest through
exactly one root input gets a bump PR to that release, which lands on its own. No person or agent hand-bumps a
flake pin. Pins through mise or the installer stay out of scope: no moq-dev,
kixel-ai, or kixelated repository uses them.

The epic finishes with an end-to-end run: a merge to `src/` cuts a release,
and the watcher opens and lands a bump to it in an enrolled repository whose
stubs that release changes, with `quest init`'s refreshed stubs in the PR.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan), after moq-dev/moq sat on
`93c9c2ef` past [moq-dev/quest#646](https://github.com/moq-dev/quest/pull/646),
so quest spawns there kept writing XS quests on Haiku 5.5 xhigh and hit its
rate limits until a hand bump
([moq-dev/moq#8623](https://github.com/moq-dev/moq/pull/8623)). The bump pass
from [moq-dev/quest#550](https://github.com/moq-dev/quest/pull/550) never ran:
the host's watcher has no `--bump` flags, since its wiring sits in the stale
draft [kixelated/nixos#36](https://github.com/kixelated/nixos/pull/36).

- What do consumers pin? ✅ A release, cut on every merge that changes what ships
  (rejected: quest's `main`, which the bump pass followed before).
- What bumps them? ✅ The watcher's `--bump`, following the latest release
  (rejected: Renovate with a stale-stub check, since hosted Renovate cannot run
  `quest init` or `quest check --fix` and most bumps need them: 48 quest
  commits touched skills from 2026-11-01 to 2026-11-12; Renovate with a
  fixup workflow in each consumer; Kixel Code, which runs no host jobs until
  its m1). Kixel Code retires the watcher later and takes bumps with it.
- Do bumps wait for a merge click? ✅ No, they land once checks pass, as the
  bump pass does today (rejected: a click, which Kixel Code requires of
  dependency bumps; a quest bump is the exception).
- Which repositories? ✅ Every other repository moq-bot is installed on whose
  `flake.lock` locks quest through exactly one root input. quest's own
  `quest-pinned` input, the merge driver's, stays on Dependabot's weekly nix
  update (`flake.nix`); bumping it here would cut a release, since it changes
  the flake, which would trigger another bump (rejected: a `--bump` list in the host's
  configuration, since #36's list went stale within five days).

Turning it on is the host's work, planned in kixelated/nixos's tree.

## Waiting

- kixelated/nixos: the quest watcher runs the bump pass, planned as
  `quest/m0/quest-bump.md` there
  ([kixelated/nixos#70](https://github.com/kixelated/nixos/pull/70)); check
  that the `quest-land` journal on the maintainer's host shows a `bump` line.
