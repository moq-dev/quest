# [XS] moq-dev repositories pick up model routing

## Goal

moq-dev/moq and moq-dev/moq.pro pin a `quest` that routes quests and
reviews by size, so their spawns and reviews use the built-in tables.

## Plan

Decided 2026-11-04 (user, /quest-plan follow-up of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)): every
repository uses the same settings, so nothing in them changes but the pin.

- moq-dev/moq pins a commit in `flake.nix`'s `quest` input; moq-dev/moq.pro
  pins only through `flake.lock` (`nix flake update quest`). Open one PR in
  each, bumping to a `main` commit that has every other quest in
  [the epic](/quest/m0/model-routing/README.md).
- Neither repository's `AGENTS.md` overrides the tables.
- Each bump runs `quest check --fix` with the new `quest` and commits the
  result, since a `quest` past
  [moq-dev/quest#518](https://github.com/moq-dev/quest/pull/518) rejects
  epic READMEs that still list their children (coordinator, 2026-11-05,
  follow-up of #518; [Pin sync](/quest/m0/pin-sync.md) does the same for
  its automated bumps).

## Required

- [Route by size](/quest/m0/model-routing/models.md) - `/quest-spawn` reads the built-in size table
