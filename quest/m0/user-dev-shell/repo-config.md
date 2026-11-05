# [S] Repositories drop their dev-shell config

## Goal

moq-dev/quest, moq, moq.pro, rind, and rust2 carry no dev-shell hooks and no
instructions to wrap commands in Nix: each drops its direnv `SessionStart`
hook from `.claude/settings.json` and `.codex/hooks.json` with the scripts
and tests behind them, and each AGENTS.md drops its `nix develop`
instructions. Agents there still run
the pinned tools, through the maintainer's user-level hooks. One PR per
repository.

## Plan

Decided 2026-11-03 (maintainer, /quest-unblock); see the
[epic](/quest/m0/user-dev-shell/README.md).

- moq's four Quest worktree hook entries are not this quest's: decided
  2026-11-04 (maintainer, /quest-complete),
  [moq-dev/moq#7889](https://github.com/moq-dev/moq/pull/7889) removes them
  on its own.
- Keep every other hook: moq.pro's `submodule.sh`, `worktree.sh` (its own
  submodule-aware worktrees, not Quest's), and `tofu-secrets.py`.
- CONTRIBUTING.md's human setup (`nix develop` to match CI) stays; only the
  agent-facing instructions go. In this repository, AGENTS.md's "`quest`
  means `bun run --silent quest`" note stays, since it names which `quest`
  to run, not how to load it.
- Check each repository from a fresh worktree on a host with the user-level
  hooks: a new Claude Code session and a new Codex session both resolve the
  dev shell's tools (`which just`, `quest --version` where pinned) with no
  `nix develop` and no manual `direnv allow`.
- User-level hooks are on every host with direnv and Nix (2026-11-04,
  /quest-unblock): `desktop`, `nixos2` and `nixos` have the dev-shell
  `SessionStart` hook in `~/.claude-personal/settings.json`. On `nixos` the
  maintainer chose to discard the checkout's local edits; they are kept as
  branch `backup/nixos-local-2026-11-04` and
  `.git/nixos-local-edits-2026-11-04.patch` there. `kixtop` has neither
  direnv nor Nix, so the hook is a no-op there.
