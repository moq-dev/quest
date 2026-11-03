# [S] quest init writes no hook entries

## Goal

`quest init` no longer writes Claude Code hook entries into a repository's
`.claude/settings.json`, and removes the `quest worktree hook` entries an
earlier version wrote, including ones a repository wrapped, such as
moq-dev/moq's `nix run "${CLAUDE_PROJECT_DIR}#quest" -- worktree hook`.
`quest uninstall` removes both forms too. The README and SETUP.md describe the
worktree hooks as an opt-in a user adds to their own Claude settings, with
the entries to add.

## Plan

Decided 2026-11-03 (maintainer, /quest-unblock): repository config applies
to every contributor, so Quest's hooks become user-level opt-in; see the
[epic](/quest/m0/user-dev-shell/README.md).

- Replaces the wrapped-hooks quest (moq-dev/moq, 2026-11-03), which widened
  `isQuestHook` (`src/core/init.ts`) so `init` would accept wrapped hooks.
  Keep its matching rule for removal: a command hook whose last two words
  are `worktree hook` is Quest's.
- `HOOK_EVENTS` and the hook plan in `src/core/init.ts` stop adding
  entries; `init` reports each entry it removes. The enrollment setup PR
  ([moq-dev/quest#431](https://github.com/moq-dev/quest/pull/431)) uses the
  same plan, so it stops proposing hooks too.
- The `quest worktree hook` command stays, for users who opt in.
- Test `init` and `uninstall` on a repository with plain and wrapped
  entries, and with other hooks beside them, which stay.
