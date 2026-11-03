# Agents get the dev shell from user settings, not repository config

## Goal

Agents in moq-dev's repositories run tools without caring about Nix: each
maintainer's own Claude Code and Codex settings load the repository's dev
shell into every session's commands, so no repository forces direnv, Nix, or
`quest` on its contributors through checked-in hooks. No repository carries a
dev-shell `SessionStart` hook, a Quest worktree hook, or AGENTS.md
instructions to wrap commands in `nix develop`, and `quest init` writes no
hook entries.

## Plan

Decided 2026-11-03 (maintainer, /quest-unblock of
[moq-dev/quest#423](https://github.com/moq-dev/quest/pull/423)'s wait to
install `quest` on Claude's `PATH`):

- Install `quest` on the `PATH` Claude Code starts with? ✅ No (rejected:
  `nix profile add github:moq-dev/quest` on every host).
- How should sessions reach a pinned `quest` and the rest of the dev shell?
  ✅ A dev-shell hook in the maintainer's own Claude settings (rejected: hook
  entries that `nix run` the repository's pinned input, as moq-dev/moq does;
  dropping the hooks with no replacement). Reason: "We don't want to force
  direnv+nix for other users"; repository config applies to every
  contributor.
- Repository-level direnv `SessionStart` hooks in quest, moq, moq.pro, rind,
  and rust2? ✅ Remove them from all five once the user-level hook loads the
  dev shell (rejected: keep them).
- Quest's worktree hooks? ✅ Drop them from repositories, and `quest init`
  stops writing hook entries; the hooks become an opt-in user-level setup
  (rejected: this repository and moq only; this repository only; moving them
  into the maintainer's settings).
  [moq-dev/quest#423](https://github.com/moq-dev/quest/pull/423) is closed.
- Codex? ✅ A user-level Codex `SessionStart` hook does the same capture, and
  the repositories' `.codex/` dev-shell hooks go (rejected: Claude only).
- A fresh worktree needs `direnv allow`: direnv keys each approval by the
  SHA-256 of the `.envrc`'s absolute path and contents
  (`~/.local/share/direnv/allow/`, 1,706 entries on the maintainer's host on
  2026-11-03), so nothing carries over from the main checkout. ✅ The
  user-level hook allows a checkout itself when its `.envrc`, `flake.nix`,
  and `flake.lock` match the remote's default branch (rejected: whitelisting
  `~/work` and `~/worktrees` in `direnv.toml`, which would also evaluate a
  fork PR's dev shell; keeping manual allows). A branch that changes them
  still needs a manual allow. Amended 2026-11-03 (review of
  [moq-dev/quest#458](https://github.com/moq-dev/quest/pull/458)): those
  three files alone don't make a checkout reviewed. Any repository's fresh
  clone matches its own default branch. A fork PR head can change another
  file the dev shell runs, such as moq.pro's `dev/mbx-shim.sh`. Both were
  auto-allowed in a reproduction against the merged hook.
  [The allow rule](/quest/m0/user-dev-shell/allow-rule.md) narrows it to
  trusted repositories and reviewed code.
- AGENTS.md instructions to run tools through `nix develop`? ✅ Remove them in
  all five repositories once the user-level hooks are on every host the
  maintainer runs agents on (rejected: this repository only; keeping them as
  a fallback).

The user-level hooks live in [kixelated/dotfiles](https://github.com/kixelated/dotfiles),
installed into each Claude profile's `settings.json` and Codex's user
config, and generalize this repository's `.claude/hooks/direnv.sh` and
moq-dev/moq's `.codex/hooks/direnv.sh`.

## Required

- [The dev-shell hook allows only trusted, reviewed checkouts](/quest/m0/user-dev-shell/allow-rule.md) - the user-level hook's automatic `direnv allow` skips other repositories' clones and fork PR heads
- [quest init writes no hooks](/quest/m0/user-dev-shell/init-hooks.md) - `quest init` stops writing hook entries and removes the ones it or a wrapper wrote; the docs describe the hooks as user-level opt-in
- [Repositories drop dev-shell config](/quest/m0/user-dev-shell/repo-config.md) - quest, moq, moq.pro, rind, and rust2 drop their dev-shell hooks, Quest worktree hooks, and `nix develop` instructions
