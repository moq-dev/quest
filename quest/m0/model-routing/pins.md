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

## Required

- [Route by size](/quest/m0/model-routing/models.md) - `/quest-spawn` reads the built-in size table
- [Review by size](/quest/m0/model-routing/review-effort.md) - `quest review` reads the built-in review table
- [Sizes include judgment](/quest/m0/model-routing/size-judgment.md) - the guide's size definition the tables rely on
