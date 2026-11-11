# [M] Split S and M writers between two Opus efforts

## Goal

`quest unblocked --json` routes each S quest to Opus low or medium, and
each M quest to Opus medium or high, 50/50. The split is stable per quest,
and the review table stays fixed while it runs. Each `Implementer:` line
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
- Escapes are too rare to separate the arms, about 2% of PRs. Compare
  first-round findings from the fixed review table, rounds, hand-backs,
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

- [Review table](/quest/m0/routing-evidence/review-table.md) - the review
  efforts held fixed while the arms run
- [usage through token-max](/quest/m0/routing-evidence/usage-token-max.md) -
  counts sub-agent writers' cost, without which an arm's cost is undercounted
