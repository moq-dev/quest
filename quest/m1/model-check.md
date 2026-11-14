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
  ([moq-dev/quest#584](https://github.com/moq-dev/quest/pull/584)), then
  each milestone (rejected: each milestone only)

Audit the routing from the records of the PRs merged since the last run,
with `quest usage --since <the last run's date>`, whose accuracy rollup reads each body's
`## Models` size and implementers and its `## Review` reviewer. It tallies each implementer by the size
on its own `Implementer:` line where it carries one, such as `(iterate, XS)`,
not the PR's `## Models` size, so a small iterate on a large PR counts as the
work it was routed for. It counts each reviewer's findings, fixed, refuted, settled (a merged PR's last all-low round), and open,
across every round on the branch, from the tally its record keeps, and leaves design
checkpoints and outages to count by hand:

- Tally by size and by implementing harness, model, and effort: review
  scores, review rounds, findings fixed versus refuted, design checkpoints reached, PRs
  handed back as drafts, and later PRs that name it under `## Caused by`
  (`quest context`'s Pull requests section). Tally
  outages that skipped quests by harness.
- Move a size to a stronger model or effort where its PRs needed clearly
  more rounds or fixes than the size above, and to a cheaper one where its
  reviews come back clean. Do the same for the review efforts in `src/cli/models.ts`
  from what later reviews and follow-ups found that a review missed. Record the tallies in
  the next run's Plan as its baseline.
- Recommend each change to a list's order, harness, or effort to the
  maintainer with its tally, as a decision in the PR, rather than changing
  it unasked. Replacing a stale model id with the same vendor's newer one,
  below, needs no decision, as this check always did.
- Chart cost against quality for every writer and reviewer cell, as decided
  2026-11-11 (user, /quest-plan, moq-dev/quest#642's follow-ups), so a
  routing change is read off the frontier rather than tables. The agent
  running the check makes the charts itself, from the saved
  `quest usage --since <date> --json` (with `--ssh` for each host that runs
  agents) and the benchmark table below. The charts are an artifact of the
  run, and no chart code goes into `quest`. It draws them as Mermaid
  charts in its PR body, which GitHub renders and any harness can write
  (user, 2026-11-14, /quest-run on
  [moq-dev/quest#721](https://github.com/moq-dev/quest/pull/721); rejected:
  images in a secret gist, a claude.ai page made by hand). Mermaid's
  quadrant charts scale both axes to 0-1, so each title gives the scales
  and each point's label carries its PR count. The body also puts every
  plotted number in tables, so a reviewer can check the charts. Each
  chart names its date range, the command, and each point's PR count.
  Points too thin for the run's variance estimate stay on the chart,
  marked thin in their label, never dropped. Cells whose
  `Implementer:` effort is `unknown` stay separate points. The charts:
  - Writers, one point per `accuracy` row (size, model, effort): cost per
    merged PR, `spent.cost / spent.pulls`, against each quality measure
    on its own chart. The measures are first-round findings per PR
    (`firstRounds.findings` over `firstRounds.pulls`), review rounds per
    reviewed PR (`tally.rounds / reviewed`), hand-backs per PR
    (`handedBack / pulls`, which counts only drafts still open until
    [hand-backs on merged PRs](/quest/m0/routing-evidence/handbacks.md)
    lands), and later
    `## Caused by` escapes per merged PR (`fixes / merged`).
  - Local reviewers, one point per `reviewers` row (PR size, harness,
    model, effort, shadow): cost per PR reviewed, `spent.cost /
    spent.pulls`, against findings per reviewed PR (`tally.findings` over
    `reviewed`) and the share fixed, `tally.fixed` over the findings
    settled one way or another (fixed, refuted, or settled).
  - Online reviewers, which run on flat plans and so have no cost per
    review, on a chart of their own: one point per `online` row, coverage
    (`reviewed / merged`) against findings per reviewed PR, labelled with
    its acceptance (`accepted / findings`).
  - Published benchmarks, one chart per suite in the table below: score
    against that suite's cost per task, for the same models and efforts,
    with the frontier drawn. Benchmark and PR metrics differ, so compare
    where each cell sits on each chart's frontier, not its values; flag a
    cell on the frontier in one and not the other.
- Published benchmarks, refreshed each run: rows with a stated effort, each
  with its source and the date it was read. Cost is per task in the suite's
  own terms; `~` marks a value derived from the source's prose.

  | Suite | Model | Effort | Score | $ per task | Read |
  |---|---|---|---|---|---|
  | [mypriors](https://mypriors.com/adamholter) 10-benchmark index, subscription cost | Haiku 5.5 | high | 30 | 0.0034 | 2026-11-09 |
  | mypriors | Haiku 5.5 | xhigh | 34.6 | 0.0053 | 2026-11-09 |
  | mypriors | Sonnet 5.5 | medium | 30.7 | 0.012 | 2026-11-09 |
  | mypriors | Opus 5.5 | low | 34.7 | 0.015 | 2026-11-09 |
  | mypriors | Opus 5.5 | medium | 48 | 0.037 | 2026-11-09 |
  | mypriors | Opus 5.5 | high | 51.7 | 0.052 | 2026-11-09 |
  | mypriors | Opus 5.5 | xhigh | 57.3 | 0.092 | 2026-11-09 |
  | mypriors | gpt-6.1-sol | low | 34.8 | 0.0094 | 2026-11-09 |
  | mypriors | gpt-6.1-sol | medium | 46.3 | 0.021 | 2026-11-09 |
  | mypriors | gpt-6.1-sol | high | 50.3 | 0.034 | 2026-11-09 |
  | mypriors | gpt-6.1-sol | xhigh | 52.5 | 0.045 | 2026-11-09 |
  | mypriors | Fable 5.2 | medium | 56 | 3.8 | 2026-11-09 |
  | [Anthropic's cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence), SWE-bench Pro 478-problem subset, % solved | Sonnet 5.5 | medium | ~80.6 | ~0.057 | 2026-11-13 |
  | Anthropic, SWE-bench Pro | Sonnet 5.5 | high | 87.6 | ~0.096 | 2026-11-13 |
  | Anthropic, SWE-bench Pro | Opus 5.5 | low | 87.4 | 0.11 | 2026-11-13 |
  | Anthropic, SWE-bench Pro | Opus 5.5 | medium | 92.8 | 0.21 | 2026-11-13 |
  | Anthropic, SWE-bench Pro | Opus 5.5 | high | 95.3 | 0.29 | 2026-11-13 |
  | Anthropic, SWE-bench Pro | Opus 5.5 | xhigh | 96.7 | 0.74 | 2026-11-13 |
  | [Artificial Analysis](https://artificialanalysis.ai/models/comparisons/claude-sonnet-5-5-high-vs-claude-opus-5-5-low), Terminal-Bench 4.0, % | Haiku 5.5 | xhigh | 29.3 | 0.25 | 2026-11-11 |
  | Artificial Analysis, Terminal-Bench 4.0 | Sonnet 5.5 | medium | 29.8 | 0.78 | 2026-11-11 |
  | Artificial Analysis, Terminal-Bench 4.0 | Sonnet 5.5 | high | 43.9 | 1.64 | 2026-11-13 |
  | Artificial Analysis, Terminal-Bench 4.0 | Opus 5.5 | low | 31.3 | 0.98 | 2026-11-13 |

  Anthropic gives Sonnet high's cost per solved task ($0.11), Sonnet
  medium as about 7 points lower at about 59% of high's cost per task, and
  calls its figures directional. Its guide also has rows on internal
  suites without a cost per task, which stay out. The `max` rows stay out
  too, since `quest agent` and `quest review` refuse `max`.

- Read [routing evidence](/quest/m0/routing-evidence/README.md)'s readout
  and baseline first: its shadow reviews and writer A/B measure the cells
  that observational tallies cannot separate.
- Baseline from m0's routing audit
  ([moq-dev/quest#584](https://github.com/moq-dev/quest/pull/584)): the 25
  PRs merged from 2026-11-07T22:30:45Z, when routing landed in
  [moq-dev/quest#558](https://github.com/moq-dev/quest/pull/558), to
  2026-11-09T17:00Z, by GitHub's `merged_at`, with their records from
  `quest usage --since 2026-11-06 --json`. `quest usage` selects by update
  time with open PRs included, so filter its PRs by merge time. Writers on
  their table entry:
  - XS Haiku high: none; both merged XS PRs ran another model.
  - S Opus low: 4 PRs, 0 handed back, score 10.0, 1.3 rounds, 1 fixed.
  - M Opus medium: 2 PRs, 0 handed back, score 9.5, 2.0 rounds, 0 fixed.
  - L Opus high: 3 PRs, 0 handed back, score 10.0, 3.0 rounds, 4 fixed.
  - Sol reviews, latest round's fixes: low 1 PR, 0 fixed; medium 17 PRs,
    4 with fixes, 4 fixed; high 3 PRs, 2 with fixes, 4 fixed; xhigh 1 PR,
    0 fixed. No PR names a routed PR under `## Caused by`, so no review
    miss showed, and no outage skipped a quest.
  - Unfinished then, not counted: open
    [moq-dev/quest#583](https://github.com/moq-dev/quest/pull/583),
    [moq-dev/quest#586](https://github.com/moq-dev/quest/pull/586), and
    [moq-dev/quest#588](https://github.com/moq-dev/quest/pull/588), and
    [moq-dev/quest#553](https://github.com/moq-dev/quest/pull/553) (M,
    merged 2026-11-09T17:33Z after a hand-back). Count those that merged
    in m1's run.
  - Too thin (0-4 PRs per cell) to move a size; no table changed. Watch
    iterates below the size's effort, and `Implementer:` lines without an
    effort (6 of the 20 lines said `unknown`).
  - Changed after that run rather than on tallies (maintainer, 2026-11-09):
    XS writes on Haiku xhigh instead of high. Tally that cell fresh. The
    source was the mypriors rows of the benchmark table above:
    - Sonnet 5.5 sat below the frontier at every effort, so it was rejected
      for XS then, though Anthropic's
      [model guide](https://claude.dev/blog/which-claude-model-should-you-build-with/)
      favors it for scoped coding.
    - Fable 5.2 was rejected for XL, which stays on Opus xhigh, on the
      frontier; zero-data-retention organizations may also be refused
      Fable.
    - S looked lopsided: Opus low scored well below its Sol medium fallback
      (34.7 against 46.3) for $0.006 less a task.
  - Changed again (maintainer, 2026-11-11): XS writes on Sonnet high
    instead of Haiku xhigh, since two Haiku XS agents in a row on
    [moq-dev/quest#643](https://github.com/moq-dev/quest/pull/643) died
    refilling context right after compaction: Haiku 5.5 bills 5x past 100k
    input, so the maintainer caps its auto-compact window there, barely above an
    agent's 40-60k fixed load. Sonnet 5.5's price is flat over its 1M
    window. mypriors has no Sonnet high row, so tally this cell rather than
    compare it there. Anthropic's
    [cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)
    puts Sonnet 5.5 high level with Opus 5.5 low (87.6% against 87.4%) at
    about the same cost per solved task, and medium about 7 points below
    high on its SWE-bench Pro subset.
  - Changed again (maintainer, 2026-11-13), on Anthropic's
    [model guide](https://claude.dev/blog/which-claude-model-should-you-build-with/),
    which puts scoped coding on Sonnet 5.5 and advises moving up a model
    rather than past `high`: S writes on Opus 5.5 medium instead of low,
    whose S PRs averaged 4.7 review rounds over 6 reviewed; and nothing
    runs `max`, which `quest agent` and `quest review` refuse. XL stays on
    Opus xhigh: the maintainer first moved it to Fable 5.2 medium, then
    kept Opus, since a Max or Ultra plan caps Fable at half its weekly
    limit and Fable uses that limit faster (Theo Browne's
    [video](https://www.youtube.com/watch?v=XtykeVoSmP8) estimates about
    $3k a month of Fable against $14k of Opus on the $200 plan). XS stays Sonnet high, since `quest usage` had no
    Sonnet medium runs to compare. The
    writer A/B ([moq-dev/quest#720](https://github.com/moq-dev/quest/pull/720)) tests each change
    against its alternative, Fable medium on XL included; tally the S cell
    fresh.
- Compare both tables' models (in `src/cli/models.ts`) with each vendor's current models: the newest
  model of each tier the tables pin. Bump any that are stale, and check that both CLIs
  accept the new ids and the pinned efforts. `--deep` and its strongest-model
  tier were dropped in
  [moq-dev/quest#361](https://github.com/moq-dev/quest/pull/361).
  - The review efforts follow the PR's size since
    [moq-dev/quest#493](https://github.com/moq-dev/quest/pull/493) (user,
    2026-11-04): Sol medium, medium, high, xhigh, and xhigh for XS to XL
    (user, 2026-11-11). It restores the efforts the
    [token waste](/quest/m0/token-waste/README.md) audit lowered to low,
    medium, medium, high, and xhigh on 2026-11-05, raising XS, M, and L. Opus
    low, low, medium, high, and xhigh when Sol wrote the code (agent's choice).
    They replaced Codex `xhigh` and Claude `high` (maintainer, 2026-11-03), for
    which Claude Code 2.1.316 ran `claude-opus-5-5` with `--effort high` and
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

## Related

- [Routing evidence](/quest/m0/routing-evidence/README.md) - the experiments
  and records these tallies read
