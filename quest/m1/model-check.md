# [M] Model check

## Goal

Each milestone, `quest`'s built-in model tables, which harness, model, and
effort each quest size and each PR size's review rank, in order, use each
vendor's newest models at efforts retuned from how the last milestone's PRs
went, and the reviewers still run nothing from a reviewed head.

## Plan

Recurring, decided 2026-10-28 (user, /quest-plan of the follow-ups from
[moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)) as the
review harness check. The m0 run was
[moq-dev/quest#426](https://github.com/moq-dev/quest/pull/426). Extended on
2026-11-04 (user, /quest-plan follow-up of
[moq-dev/quest#487](https://github.com/moq-dev/quest/pull/487)) to audit
the size tables of model routing (`src/cli/models.ts`):

- Should the routing audit be its own recurring quest?
  - ✅ Merge it into this check, so one quest owns the tables
  - A separate audit owning the tables
  - A separate audit of efforts only
- When does it run? ✅ First in m0 once routing lands
  ([m0's run](/quest/m0/model-check.md)), then each milestone (rejected:
  each milestone only)

Audit the routing from the records of the PRs merged since the last run,
with `quest usage --since <the last run's date>`, whose accuracy rollup reads each body's
`## Models` size and implementers and its `## Review` reviewer. It tallies each implementer by the size
on its own `Implementer:` line where it carries one, such as `(iterate, XS)`,
not the PR's `## Models` size, so a small iterate on a large PR counts as the
work it was routed for. It counts fixed and refuted findings only from the
round before each PR's latest, the one its record keeps, and leaves design
checkpoints and outages to count by hand:

- Tally by size and by implementing harness, model, and effort: review
  scores, review rounds, findings fixed versus refuted, design checkpoints reached, PRs
  handed back as drafts, and later PRs that name it under `## Caused by`
  (`quest context`'s Pull requests section). Tally
  outages that skipped quests by harness.
- Move a size to a stronger model or effort where its PRs needed clearly
  more rounds or fixes than the size above, and to a cheaper one where its
  reviews come back clean. Do the same for the review table from what later
  reviews and follow-ups found that a review missed. Record the tallies in
  the next run's Plan as its baseline.
- Recommend each change to a list's order, harness, or effort to the
  maintainer with its tally, as a decision in the PR, rather than changing
  it unasked. Replacing a stale model id with the same vendor's newer one,
  below, needs no decision, as this check always did.

- Compare both tables' models (in `src/cli/models.ts`) with each vendor's current models: the newest
  general model. Bump any that are stale, and check that both CLIs
  accept the new ids and the pinned efforts. `--deep` and its strongest-model
  tier were dropped in
  [moq-dev/quest#361](https://github.com/moq-dev/quest/pull/361).
  - The review efforts follow the PR's size since
    [moq-dev/quest#493](https://github.com/moq-dev/quest/pull/493) (user,
    2026-11-04): Sol low, medium, medium, high, and xhigh for XS to XL since
    the [token waste](/quest/m0/token-waste/README.md) audit (user,
    2026-11-05; it had high and xhigh for M and L), and Opus low, low,
    medium, high, and high when Sol wrote the code (agent's choice). They replaced Codex `xhigh` and Claude `high` (maintainer,
    2026-11-03), for which Claude Code 2.1.316 ran `claude-opus-5-5` with `--effort high` and
    `/code-review high`, and codex-cli 0.166.0 ran `gpt-6.1-sol` with
    `model_reasoning_effort="xhigh"`, both with `quest review`'s flags.
  - m0 found, with Claude Code 2.1.316 and codex-cli 0.166.0:
    `claude-opus-5-5` is Anthropic's default general model, above it only the
    premium Fable tier (`claude-fable-5-1`); `gpt-6.1-sol` is Codex's
    first-listed "latest workhorse" in `~/.codex/models_cache.json`, beside
    the frontier `gpt-6-astra`. Neither pin changed.
  - Check that the pinned Claude Code maps the Claude id to each cloud
    provider. `quest review` keeps Bedrock, Vertex and Foundry routing
    ([moq-dev/quest#424](https://github.com/moq-dev/quest/pull/424)) but
    strips `ANTHROPIC_MODEL`, so the pin must resolve on each route.
    Claude Code 2.1.316's model catalog lists `claude-opus-5-5` with
    `provider_ids` (Bedrock `us.anthropic.claude-opus-5-5`; Vertex and
    Foundry `claude-opus-5-5`). Find the new pin's entry the same way, and
    plan a quest if a provider has none (coordinator, /quest-complete
    follow-ups, 2026-11-03).
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
  way: in that milestone's directory, requiring this milestone's README,
  carrying forward the model ids and efforts it found, the routing tallies
  as a baseline, and anything to check first.

## Required

- [moq-dev adoption](/quest/m0/README.md) - m0 completes first
