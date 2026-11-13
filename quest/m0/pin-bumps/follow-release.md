# [S] The bump pass follows the latest release

## Goal

A bump moves each target to the commit of the watched repository's latest
release instead of its base's head, so consumers run only released quest, and
the PR names the release it moves to.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan; see the
[epic](/quest/m0/pin-bumps/README.md)): ✅ consumers pin releases (rejected:
quest's `main`).

Keep the pin lock-only: `flake.nix` names no revision or tag, and
`flake.lock` locks the release's commit, so a bump stays a lock-only diff.
Today the pass strips only a revision from the input's URL (`questInput` and
`unpin` in `src/cli/land-bump.ts`); strip a tag too, or a later
`nix flake update` resolves the tag again and moves the pin back. A repository
that wants a slower cadence leaves moq-bot off and pins by hand.

Key a target's recorded bump on the release it moved to, not the base head the
watcher passes in: otherwise a pass that runs before the Release workflow tags
the base records the target done, and the release that follows is skipped
until `main` moves again.

## Required

- [Release every merge that changes what ships](/quest/m0/pin-bumps/release.md) - the releases a bump follows
