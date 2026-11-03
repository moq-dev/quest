# [S] This repository installs its own worktree hooks

## Goal

Claude Code sessions in moq-dev/quest reclaim their subagents' checkouts
through `quest worktree hook`, as `quest init` sets up in other
repositories. `quest` is reliably available to Claude Code's hook
environment here, and on `PATH` for the merge driver, without running a PR
head's code. `quest init` then installs the hooks in this repository's
`.claude/settings.json`.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], m0. Sources:
[moq-dev/quest#350](https://github.com/moq-dev/quest/pull/350)'s decision 1a
and [moq-dev/quest#359](https://github.com/moq-dev/quest/pull/359).

- [moq-dev/quest#350](https://github.com/moq-dev/quest/pull/350) shipped the
  hooks but, by its decision 1a, didn't install them here: Claude Code runs
  hooks in its own environment, not the direnv dev shell, and the merge
  driver also needs `quest` on `PATH`. This repository's 65 leaked
  worktrees (8.2 GB, 2026-10-23) were the measurement behind the hooks.
- The dev shell's `quest` is the reviewed `quest-pinned` build
  ([moq-dev/quest#344](https://github.com/moq-dev/quest/pull/344)), while
  `bun run --silent quest` runs the checkout. Choose how hooks reach a
  pinned `quest` outside the dev shell, for example an installed release
  that `SETUP.md` asks contributors for, and say what happens for a
  contributor without one.
