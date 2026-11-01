# [S] Make the merge driver's fallback visible

## Goal

A merge that the `quest` merge driver can't run says so, rather than
silently leaving plain conflict markers in link lists. This repository's dev
shell provides a `quest`, so its own merges resolve link lists.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR /quest-complete run). The driver config runs `quest resolve` only when `quest` is on PATH, and
otherwise falls back to `git merge-file` without a word. In moq-dev/quest
the dev shell has no `quest`, so merge agents hand-resolved link lists. A
hand-resolved conflict needs a fresh review, so link-list conflicts stalled
merges on Codex reviews (#233, #250, #255). The same merges resolved cleanly
once `quest` was put on PATH.

- The fallback prints to stderr that `quest` wasn't found and link lists
  weren't auto-resolved, naming the file. Keep the fallback itself.
- This repository's flake puts a pinned `quest` release in the dev shell,
  not a build of the checkout. That way merging a PR head never runs that
  head's code.
- Rejected: `quest init` writing an absolute binary path, which breaks on
  upgrades and Nix store paths.
