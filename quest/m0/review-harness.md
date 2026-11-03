# [S] Review harness check

## Goal

Each milestone, `quest review`'s pinned models are each vendor's newest for
their tier, and the reviewers still run nothing from a reviewed head.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)).

- Compare `MODELS` in `src/cli/review.ts` with each vendor's current models:
  the default tier is the newest general model at medium effort, and the deep
  tier the strongest one. Bump any that are stale, and check that both CLIs
  accept the new ids.
- Run the live sandbox test, `just review-sandbox`, with the CLIs installed
  at the time, and plan a quest for any failure.
- Extend the live sandbox test (decided 2026-11-01, user, /quest-plan of
  [moq-dev/quest#341](https://github.com/moq-dev/quest/pull/341)'s
  suggested follow-ups):
  - macOS keychain logins: both CLIs can keep their login in the keychain,
    where there is no file to copy into the disposable config home, so the
    test runs only on Linux today.
  - More of Claude Code's project settings as plants:
    `.claude/settings.local.json`, `statusLine`, `apiKeyHelper`, `env`, and
    permission rules.
  - Codex reads a linked worktree's hooks from the main checkout's
    `.codex/hooks.json`. Check whether the land fixer
    (`src/cli/land-fix.ts`) or headless agents (`quest agent`) rely on
    worktree-local Codex hooks.
- This quest recurs. The PR that finishes this run creates
  `/quest/m1/review-harness.md` with this Goal, listed in m1's `Required`,
  and `Required: /quest/m0/README.md`, so the next run becomes ready when m0
  completes. Each run creates the next milestone's run the same way, carrying
  forward the model ids it found and anything to check first.
