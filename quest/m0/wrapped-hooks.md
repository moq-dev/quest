# [XS] quest init recognizes wrapped worktree hooks

## Goal

`quest init` treats any command hook whose arguments end in `worktree hook`
as its own, such as moq-dev/moq's
`nix run "${CLAUDE_PROJECT_DIR}#quest" -- worktree hook`, which runs the
`quest` the repository pins. It needs no configuration. In a repository with
wrapped hooks, `quest init` then succeeds without changing them, and
`quest uninstall` removes them like the plain ones.

## Plan

Decided 2026-11-03 (maintainer, moq-dev/moq, planned through moq-dev/moq's
coordinator):

- How should `quest init` recognize its hook when a repository wraps it?
  - ✅ Match any command hook whose arguments end in `worktree hook`
  - A configured hook command (rejected)
  - No change (rejected)

Milestone: m0, ranked after [Worktree hooks here](/quest/m0/worktree-hooks.md).
m0 is adoption on moq-dev's own repositories, and moq-dev/moq hits this
today.

What happens:
[moq-dev/moq#7674](https://github.com/moq-dev/moq/pull/7674) runs moq's hooks
through its flake's pinned `quest`, so agents use the version moq pins.
`isQuestHook` (`src/core/init.ts`) matches only the exact `HOOK_COMMAND`,
`quest worktree hook`. So `quest init` counts the wrapped `WorktreeCreate`
and `WorktreeRemove` hooks as someone else's and refuses to run. The
workaround is to drop the hooks, run init, and restore them.

Implementation guidance:

- Widen `isQuestHook` to a command whose last two words are `worktree hook`.
  A fresh install still writes the plain `HOOK_COMMAND`.
- `quest uninstall` (`src/cli/setup.ts`) uses the same check, so it removes
  wrapped hooks too. Say so in its docs.
- Test a wrapped hook in init, re-init, and uninstall.
