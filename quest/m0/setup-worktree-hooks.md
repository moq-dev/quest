# [S] quest setup installs the worktree hooks

## Goal

`quest setup` installs Quest's Claude Code worktree hooks with the rest of
Quest's user-level hooks, so a user enables them and later picks up new
events by rerunning one command. The README's pasted hook JSON is gone.

## Plan

Decided 2026-11-07 (coordinator, follow-up of
[moq-dev/quest#556](https://github.com/moq-dev/quest/pull/556)): Quest
installs user-level hooks two ways. `quest setup` writes the `SessionStart` and
`SubagentStart` rule hooks from the `HOOKS` table in `src/cli/hooks.ts`
([moq-dev/quest#517](https://github.com/moq-dev/quest/pull/517)). The worktree
hooks are JSON users paste from the README's "Claude Code checkouts" section.
#556 added `SessionStart` and `SessionEnd` worktree entries, so every user had
to re-paste them, and
[moq-dev/quest#544](https://github.com/moq-dev/quest/pull/544) had to guard
each pasted command against a missing `quest`. Quest is internal tooling for
the maintainer's own hosts, so one installer is enough.

- Add the worktree events to `quest setup`, behind an opt-in such as
  `--worktrees`, since a worktree hook changes where every session runs. The
  rule hooks stay on by default. `quest hook` (or `quest worktree hook`)
  dispatches every event. Rerunning replaces Quest's earlier entries, and
  `--remove` takes them all out.
- Delete the README's pasted JSON and point at `quest setup --worktrees`.
  Keep #544's message for a missing `quest`, either in the installed command
  or in `quest setup`'s output, whichever is simpler.
- Migrate the maintainer's own hosts: entries that `quest setup` didn't write
  but that run `quest worktree hook` are recognized as Quest's and replaced, not
  duplicated.
