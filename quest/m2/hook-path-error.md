# [XS] Worktree hooks name the launch route when quest is missing

## Goal

When a Claude Code session runs Quest's worktree hooks and `quest` is not on
the `PATH` Claude Code runs hooks with, the session shows an error saying so
and how to fix it, such as launching the agent inside the project's dev shell
(`nix develop --command claude`) or installing `quest` on that `PATH`, instead
of the shell's bare `quest: command not found`. A test covers it.

## Plan

Decided 2026-11-04 (maintainer, /quest-plan).

- The failure happens in the shell, before any Quest code runs, so the fix
  belongs in the hook entry's command: a guard that checks for `quest` and
  otherwise prints the message on stderr and exits 2, which Claude Code shows
  and treats as blocking. A `WorktreeCreate` failure then aborts the worktree
  with that message.
- After [init-hooks](/quest/m0/user-dev-shell/init-hooks.md), the entries are
  a user-level opt-in that the README and SETUP.md describe, so the guarded
  entry is the documented one. `quest uninstall`'s match for Quest's own
  hooks must still recognize it.
- The test runs the documented entry with a `PATH` that lacks `quest` and
  checks the exit status and message, and with `quest` present checks that
  the hook runs.

## Required

- [quest init writes no hooks](/quest/m0/user-dev-shell/init-hooks.md) - the documented user-level hook entries this guard changes
