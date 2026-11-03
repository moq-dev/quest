# [S] Every Git call ignores inherited repository location

## Goal

Every Git subprocess the CLI runs on an explicit path finds that path's
repository, even when `quest` runs from a Git hook or
`git submodule foreach`. They share one helper that drops the
repository-local variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`
and the rest of `git rev-parse --local-env-vars`) and keeps `-c` config,
as Git itself does when it enters another repository. The command that
`quest worktree run` starts in a reserved checkout gets the same treatment.

## Plan

Decided 2026-11-03 (coordinator, /quest-complete follow-ups, under the
user's 2026-11-02 instruction to decide follow-ups from evidence): plan it,
[S], m1. No moq-dev repository runs `quest` from a Git hook (none has
lefthook, pre-commit, husky or a hooks directory), so only adopters with
such hooks reach it.

Decided 2026-11-03 (user, /quest-complete, on
[moq-dev/quest#455](https://github.com/moq-dev/quest/pull/455)):

- Should `quest worktree run` drop inherited Git location variables from the
  user's command? Today it hands the command Quest's own environment, so a
  command started from a hook in one checkout acts on that checkout's
  repository, not the reserved one it runs in.
  - ✅ Drop them, keeping `-c` config (recommended): the command runs in a
    different checkout, where an inherited location names the wrong
    repository
  - Pass the environment through unchanged, as now

Evidence, gathered 2026-11-03:

- [moq-dev/quest#445](https://github.com/moq-dev/quest/pull/445) hit it in
  the worktree hook: with an inherited `GIT_DIR` naming a submodule, the
  hook created the checkout inside the submodule. It fixed only
  `src/cli/worktree.ts` and `worktree-hook.ts`, through `discoveryEnv()`.
- A probe on 2026-11-03: a `pre-commit` hook gets `GIT_INDEX_FILE` in every
  checkout, and `GIT_DIR` too in a linked worktree. A merge driver gets
  neither in a main checkout.
- The other helpers pass the environment through:
  `gitOutput` (`src/cli/claims.ts`), `git` in `src/cli/move.ts`,
  `src/cli/github.ts`, `src/cli/tree.ts` and `src/cli/landed.ts`,
  `spawnDirectory` (`src/cli/agent.ts`) and the call in `src/cli/start.ts`.
  `tree.ts` runs Git in a submodule to resolve links into it, so a
  `quest check` from a hook reads the superproject there.

Work:

- Move `discoveryEnv()` from `src/cli/worktree.ts` to a shared module.
  Have every `git -C <path>` helper above use it. Fold the near-duplicate
  `git` helpers into it where their error handling allows, rather than
  patching each one.
- Leave `src/runner/` as it is: the runner process isn't started by Git.
- Test `quest check` with links into a submodule, run under an inherited
  `GIT_DIR` and `GIT_INDEX_FILE`.
- Have `quest worktree run` drop the same variables from the user's
  command, keeping `-c` config (`src/cli/supervise.ts:339` hands it Quest's
  own environment today), and test it from a hook-like environment.
