# [M] Split each size's writers between two arms

## Goal

`quest unblocked --json` routes each XS and S quest to Sonnet 5.5 high or
Opus 5.5 medium, each M quest to Opus medium or high, and each XL quest to
Fable 5.2 medium or Opus xhigh, 50/50. The split is stable per quest,
and the review efforts in `src/cli/models.ts` stay fixed while it runs. Each `Implementer:` line
records its arm, iterates stay on the PR's arm, and
`quest usage` reports cost, rounds, findings, hand-backs, and later
culprits per arm.

## Plan

Decided 2026-11-11 (user, /quest-plan,
[routing evidence](/quest/m0/routing-evidence/README.md)):

- Which cells?
  - ✅ S Opus low against medium, and M Opus medium against high
  - Rejected: XS Haiku xhigh against Opus low, since XS PRs rarely draw
    findings and the signal would be weak
- Amended 2026-11-11 (user, /quest-run): XS writers move from Haiku
  xhigh to Sonnet 5.5 high in a separate routing PR, which also updates
  `src/cli/models.ts`, the README, and the model check's XS baseline. Two
  Haiku agents in a row ran out of context, since the maintainer's Claude
  Code settings cap `claude-haiku-5-5`'s `autoCompactWindow` at 100k to
  stay under Haiku's 5x price past 100k input. Does XS get an arm?
  - ✅ Sonnet high against Opus low: published results disagree on this
    pair at about the same cost. Anthropic's
    [cost guide](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)
    has them even on its SWE-bench Pro subset (87.6% and 87.4%, about
    $0.11 per solved task), while
    [Artificial Analysis](https://artificialanalysis.ai/models/comparisons/claude-sonnet-5-5-high-vs-claude-opus-5-5-low)
    has Sonnet high 12.6 points ahead on Terminal-Bench 4.0 and Opus low
    about 40% cheaper per task. XS PRs rarely draw findings, so cost,
    rounds, and hand-backs carry most of its signal.
  - Rejected: Sonnet medium against Sonnet high, since the same cost
    guide puts Sonnet medium about 7 points below high on its SWE-bench
    Pro subset and 15 below on its internal agentic-coding set; no XS arm
- Re-armed 2026-11-13 (user), to test where Anthropic's
  [model guide](https://claude.dev/blog/which-claude-model-should-you-build-with/)
  and Theo Browne's
  [Opus against Fable video](https://www.youtube.com/watch?v=XtykeVoSmP8)
  disagree:
  - S Sonnet high against Opus medium: the guide puts scoped coding on
    Sonnet, Theo finds Sonnet runs up output tokens and costs about what
    Opus does. S's table entry moved from Opus low to Opus medium, the
    guide's default, since both call Opus low too weak.
  - XS Sonnet high against Opus medium rather than Opus low, the same
    contrast as S (agent's choice, since no table entry runs Opus low any
    more).
  - M Opus medium against high, as before: Theo finds medium ends its turn
    too early and calls high the best effort.
  - XL Fable medium against Opus xhigh: the guide moves up to Fable rather
    than past high, while Theo finds Opus checks verifiable work more
    carefully and a subscription gives about a quarter as much Fable. XL
    quests are rare, so report how many each arm got rather than wait for
    a detectable difference.
- Escapes are too rare to separate the arms, about 2% of PRs. Compare
  first-round findings under the fixed review efforts, rounds, hand-backs,
  and cost, and report escapes alongside.

Agent's choices, for the implementer to revisit:

- Pick the arm from a hash of the quest's path, so restarting or
  respawning a quest keeps its arm, and a dispatcher reads it from
  `quest unblocked --json` rather than drawing again.
- Record it on the Implementer line beside the size an iterate already
  records, such as `(arm B)` or `(iterate, S, arm B)`, and extend
  `implementer()` in `src/github/models.ts` to parse both, since today it
  accepts only `(XS)` and `(iterate, XS)`. A writer that ran off its arm,
  such as a fallback to Sol, counts in neither arm.
- `quest models` takes only a size, so an iterate's entry comes from the
  arm on the PR's first Implementer line: `--writer` also takes that line's
  effort, or a new option names the arm.
- [The readout](/quest/m0/routing-evidence/README.md) ends the split.

## Required

- [usage through token-max](/quest/m0/routing-evidence/usage-token-max.md) -
  counts sub-agent writers' cost, without which an arm's cost is undercounted
