# [S] moq.pro drops its Codex dev-shell config

## Goal

moq-dev/moq.pro drops its repo-level Codex dev-shell config, the same as
quest, moq, rind, and rust2 did: `.codex/hooks.json`'s `nix-devshell.sh`
`SessionStart` hook and `pretooluse-devshell.py` `PreToolUse` hook,
`.codex/config.toml`'s repo-local `BASH_ENV`/`ENV`/`ZDOTDIR`, the
`.codex/shell/` files, and their tests and `check.sh` routes. Codex there
still runs the pinned tools, through the maintainer's user-level hooks.

## Plan

Decided 2026-11-07 (maintainer): moq.pro drops all of its dev-shell config.
Its Claude direnv hook is already gone. Its Codex config stays until the
condition below holds.

- Keep `.claude/hooks/submodule.sh`, `worktree.sh`, `tofu-secrets.py`, and
  `.codex/environments/environment.toml`'s submodule setup.
- Check: in a fresh moq.pro clone with `.codex/` removed and a clean
  environment, `codex exec` resolves `which just`.

## Waiting

- Maintainer: a fresh headless Codex session in moq.pro can't load the dev
  shell without the repo hooks. The flake takes `path:./moq`, nothing
  initializes that submodule for `codex exec`, and the user-level
  `dev-shell-hook` (in the maintainer's dotfiles, outside this tree) doesn't
  initialize submodules. With the submodule initialized, the same check passed.
  Options: (a) `dev-shell-hook` runs `git submodule update --init` when
  `.gitmodules` lists an uninitialized path the flake needs; (b) keep moq.pro's
  Codex config for good, and close this quest; (c) accept that fresh clones
  need a manual submodule init. Recommendation: (a). It also fixes a cold first Claude
  session, where the user-level hook ran before moq.pro's `submodule.sh` and
  printed no `just`. Check: the Goal's check passes.
