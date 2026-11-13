# [S] The bump pass follows the latest release

## Goal

A bump moves each target to the commit of the watched repository's latest
release instead of its base's head, so consumers run only released quest, and
the PR names the release it moves to.

## Plan

Decided 2026-11-13 (maintainer, /quest-plan; see the
[epic](/quest/m0/pin-bumps/README.md)): ✅ consumers pin releases (rejected:
quest's `main`).

Keep the pin lock-only, as the pass does today: `flake.nix` names no revision
or tag, and `flake.lock` locks the release's commit, so a bump stays a
lock-only diff. A repository that wants a slower cadence leaves moq-bot off
and pins by hand.

## Required

- [Release every user-facing merge](/quest/m0/pin-bumps/release.md) - the releases a bump follows
