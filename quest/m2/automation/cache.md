# [M] Share a main-only Nix cache across runners

## Goal

Every project's runners, own-machine and cloud, read from a signed shared
cache for its Nix devShell and checks, with writes restricted to builds of
merged default-branch revisions.

## Plan

- Decided 2026-10-15: runners require a Nix devShell, so the shared cache is
  a core benefit rather than an optional extra. m0 runners rely on their
  local store and the flake's own substituters until this ships.
- Preserve the earlier R2-plus-signing-key proposal as the initial adapter;
  keep cache configuration unrelated to Quest's core format.
- Separate writer credentials and hosts from unmerged code and agent jobs.
  Writers verify the source revision and build the merged default branch only.
- Publish substituter URLs/public keys per project; scope writes and lifecycle
  policies. Evaluate a managed upload service only if simple storage is inadequate.
- Verify readers reject unsigned paths and contribution runners cannot publish
  trusted cache entries.

## Required

- [Donated checks](/quest/m2/automation/checks.md) - runner configuration and trust model
