# [S] .worktrees/ stays out of git status

## Goal

When `quest worktree` creates a checkout under a repository's `.worktrees/`,
it adds `/.worktrees/` to that repository's `$GIT_COMMON_DIR/info/exclude`
unless something already ignores the directory, so the main checkout's
`git status` never lists `.worktrees/`. The exclude is local to the clone:
no repository change, and every checkout of it shares the file.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#466](https://github.com/moq-dev/quest/pull/466)). With
Quest's worktree hooks an opt-in in each user's own Claude settings, they
run in every repository the user opens, and a repository that doesn't ignore
`.worktrees/` shows `?? .worktrees/` in its main checkout (reproduced with
`git worktree add .worktrees/a` in a fresh repository; nothing in
`src/cli/worktree.ts` writes an exclude).

- What should the quest's goal be?
  - ✅ A local exclude written by `quest worktree`
  - Rejected: telling users to add `.worktrees/` to their global gitignore;
    leaving it
- Which milestone and epic?
  - ✅ m0, in this epic beside the opt-in that exposed it
  - Rejected: m1; m2

Implementation guidance:

- Check with `git check-ignore`, as `ignored()` in `src/cli/worktree.ts`
  does, whether `.worktrees/` is already ignored, by the repository, a
  global `core.excludesFile`, or an earlier exclude, before appending.
  Query it with the trailing slash: until the directory exists,
  `git check-ignore .worktrees` misses a directory-only rule such as
  `/.worktrees/`.
- Test with a repository that has no ignore rule, one whose `.gitignore`
  already lists `/.worktrees/`, and a second checkout, which must not
  append the line again.
