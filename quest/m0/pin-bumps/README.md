# Every merge reaches every repository that pins quest

## Goal

A user-facing merge to quest's `main` ships as a release, and within the hour
every repository that pins quest and has moq-bot installed gets a bump PR to
that release, which lands on its own. No person or agent hand-bumps a pin.

The epic finishes with an end-to-end run: a user-facing merge cuts a release,
and the watcher opens and lands a bump to it in an enrolled repository whose
stubs that release changes, with `quest init`'s refreshed stubs in the PR.

## Plan

Decided 2026-11-13 (maintainer, /quest-plan), after moq-dev/moq sat on
`93c9c2ef` past [moq-dev/quest#646](https://github.com/moq-dev/quest/pull/646),
so quest spawns there kept writing XS quests on Haiku 5.5 xhigh and hit its
rate limits until a hand bump
([moq-dev/moq#8623](https://github.com/moq-dev/moq/pull/8623)). The bump pass
from [moq-dev/quest#550](https://github.com/moq-dev/quest/pull/550) never ran:
the host's watcher has no `--bump` flags, since its wiring sits in the stale
draft [kixelated/nixos#36](https://github.com/kixelated/nixos/pull/36).

- What do consumers pin? ✅ A release, cut on every user-facing merge
  (rejected: quest's `main`, which the bump pass follows today).
- What bumps them? ✅ The watcher's `--bump`, following the latest release
  (rejected: Renovate with a stale-stub check, since hosted Renovate cannot run
  `quest init` or `quest check --fix` and most bumps need them: 48 quest
  commits touched skills from 2026-11-01 to 2026-11-12; Renovate with a
  fixup workflow in each consumer; Kixel Code, which runs no host jobs until
  its m1). Kixel Code retires the watcher later and takes bumps with it.
- Do bumps wait for a merge click? ✅ No, they land once checks pass, as the
  bump pass does today (rejected: a click, which Kixel Code requires of
  dependency bumps; a quest bump is the exception).
- Which repositories? ✅ Every repository moq-bot is installed on whose
  `flake.lock` locks quest (rejected: a `--bump` list in the host's
  configuration, which #36's went stale within five days).

Turning it on is the host's work, planned in kixelated/nixos's tree.
