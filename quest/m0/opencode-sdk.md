# [M] The runner's opencode adapter uses @opencode/sdk 2.x

## Goal

The runner's opencode adapter (`src/runner/opencode.ts`) drives opencode
2.x through `@opencode/sdk` 2.x, matching the opencode that the bumped
nixpkgs ships, so Dependabot's nixpkgs bump
[moq-dev/quest#281](https://github.com/moq-dev/quest/pull/281) can land.
The flake's `opencode-sdk` check passes, and the runner's opencode tests
pass against the new SDK.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [M], m0.

- nixpkgs now ships opencode 2.0.32. `package.json` pins
  `@opencode-ai/sdk` 1.19.0, and `flake.nix`'s `opencode-sdk` check fails
  unless that pin equals `pkgs.opencode.version`, so #281 cannot land
  alone. Move to the renamed `@opencode/sdk` at the version nixpkgs ships,
  adapt the adapter to its 2.x API, and point the flake's check at the new
  package name.
- Land the nixpkgs bump in the same PR, or merge #281 into it.
- [moq-dev/quest#280](https://github.com/moq-dev/quest/pull/280) adds a
  Dependabot ignore for `@opencode-ai/sdk`, since the SDK must move with
  nixpkgs' opencode. That ignore must also cover `@opencode/sdk`.
- Run the runner's live opencode checks that the
  [Kix decision UI](/quest/m0/kix/README.md) rehearsal lists, if a runner is
  available.
