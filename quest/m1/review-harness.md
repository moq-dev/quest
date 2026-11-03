# [S] Review harness check

## Goal

Each milestone, `quest review`'s pinned models are each vendor's newest for
their tier, and the reviewers still run nothing from a reviewed head.

## Plan

Recurring, decided 2026-10-28 (user, /quest-plan of the follow-ups from
[moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)). The m0 run
was [moq-dev/quest#426](https://github.com/moq-dev/quest/pull/426).

- Compare `MODELS` in `src/cli/review.ts` with each vendor's current models:
  the newest general model, at medium effort. Bump any that are stale, and
  check that both CLIs accept the new ids. `--deep` and its strongest-model
  tier were dropped in
  [moq-dev/quest#361](https://github.com/moq-dev/quest/pull/361).
  - m0 found, with Claude Code 2.1.316 and codex-cli 0.166.0:
    `claude-opus-5-5` is Anthropic's default general model, above it only the
    premium Fable tier (`claude-fable-5-1`); `gpt-6.1-sol` is Codex's
    first-listed "latest workhorse" in `~/.codex/models_cache.json`, beside
    the frontier `gpt-6-astra`. Neither pin changed.
- Run the live sandbox test, `just review-sandbox`, with the CLIs installed
  at the time, through `quest gate`, and plan a quest for any failure.
- Check first:
  - [openai/codex#49333](https://github.com/openai/codex/issues/49333): if
    `--ignore-user-config` stops skipping the project layer, the Codex
    review's plants fire. [Codex project config](/quest/m0/codex-project-config.md)
    tracks it.
  - The test runs a login with no file to copy, such as one in the macOS
    keychain, on the credentials its CLI reads from the environment
    (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`). m0
    built that on Linux only; run it once on macOS with a keychain login.
  - Claude Code draws its status line only in an interactive session, so the
    planted `statusLine` has no control. Check whether print mode runs it now.
  - Codex reads a linked worktree's hooks from the main checkout's
    `.codex/hooks.json`. In m0 neither the land fixer (`src/cli/land-fix.ts`,
    which passes `--ignore-user-config`) nor `quest agent` used Codex hooks,
    and `quest init` installs none. Recheck if either starts to.
- The PR that finishes this run creates the next milestone's run the same
  way: listed in that milestone's `Required`, requiring this milestone's
  README, carrying forward the model ids it found and anything to check first.

## Required

- [moq-dev adoption](/quest/m0/README.md) - m0 completes first
