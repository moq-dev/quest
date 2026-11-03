# [S] Repositories drop their dev-shell config

## Goal

moq-dev/quest, moq, moq.pro, rind, and rust2 carry no dev-shell hooks and no
instructions to wrap commands in Nix: each drops its direnv `SessionStart`
hook from `.claude/settings.json` and `.codex/hooks.json` with the scripts
and tests behind them, moq drops its four Quest worktree hook entries, and
each AGENTS.md drops its `nix develop` instructions. Agents there still run
the pinned tools, through the maintainer's user-level hooks. One PR per
repository.

## Plan

Decided 2026-11-03 (maintainer, /quest-unblock); see the
[epic](/quest/m0/user-dev-shell/README.md).

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

## Waiting

- Maintainer: pull kixelated/dotfiles and run `bin/install-dev-shell.py` (or the full `install`, with `codex` on `PATH`) on `nixos` (`kixtop` has neither direnv nor Nix, so the hook has nothing to load there; it got only the effort defaults on 2026-11-03); it changes the live agent config on each host, which an agent here doesn't touch unasked. The repositories' hooks must not go before the user-level ones arrive. [kixelated/dotfiles#33](https://github.com/kixelated/dotfiles/pull/33) is merged. On 2026-11-03, `desktop` and `nixos2` had the hook in `~/.claude-personal/settings.json`, but `nixos` and `kixtop` didn't. Check on each host that `~/.claude-personal/settings.json` has the dev-shell `SessionStart` hook and that a fresh worktree's session resolves `just`
