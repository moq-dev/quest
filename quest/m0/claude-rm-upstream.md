# [XS] Get claude rm's unlock advice fixed upstream

## Goal

[anthropics/claude-code#108195](https://github.com/anthropics/claude-code/issues/108195)
asks `claude rm` to dispatch the `WorktreeRemove` hook for a checkout a
`WorktreeCreate` hook made, instead of telling the user to run
`git worktree unlock`, which removes the hook's lock. The report is filed;
this quest tracks its fix until the README's workaround can go.

## Plan

Filed 2026-11-07 after reproducing it with Claude Code 2.1.316: a locked
hook-made checkout is refused as "locked … by something other than Claude
Code" with the unlock advice, and an unlocked one is refused as having files
no repository checks. The `WorktreeRemove` hook did not fire in either case.
The README tells users to run `quest worktree remove` first, which stays
until the upstream fix ships.

Related but different, linked in the report:
[#79872](https://github.com/anthropics/claude-code/issues/79872),
[#93676](https://github.com/anthropics/claude-code/issues/93676),
[#101283](https://github.com/anthropics/claude-code/issues/101283),
[#99270](https://github.com/anthropics/claude-code/issues/99270), and
[#105317](https://github.com/anthropics/claude-code/issues/105317).

## Waiting

- anthropics/claude-code: a fix for
  [#108195](https://github.com/anthropics/claude-code/issues/108195) so
  `claude rm` dispatches `WorktreeRemove` for a hook-made checkout. Check with
  `gh issue view 108195 --repo anthropics/claude-code`. Once a release contains
  the fix, or the issue is closed as not planned, delete this quest and revisit
  the README's `quest worktree remove` workaround.
