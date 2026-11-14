# Routing evidence

## Goal

`quest usage` counts each PR's full cost and every finding caught before
merge, by writer, reviewer, model, and effort. Controlled experiments then
measure what each writer and reviewer effort buys, so routing is retuned
from evidence rather than benchmarks alone. This epic's own work is the
experiments' readout: a recommendation for each table cell they cover, put
to the maintainer as a decision, and the end of the writer A/B.

Non-goal: catching runtime escapes, such as nightly-only lanes, platform
builds, and races, in each repository's gate. Each repository's quest tree
owns that work. [The mistake audit](/quest/m0/mistake-audit.md) files it
there.

## Plan

Decided 2026-11-11 (user, /quest-plan, from an audit of PRs merged
2026-11-01 to 11-11 in moq-dev/moq, moq-dev/moq.pro and moq-dev/quest):

- Scope?
  - ✅ Records, experiments, and runtime escapes, the last in the
    repositories that own them plus the mistake audit
  - Rejected: records and experiments only; routing changes only
- Review table? ✅ Restore the efforts in place before 2026-11-05 and raise
  XS: Sol medium, medium, high, xhigh, xhigh for XS to XL, A/B tested by
  `quest review`'s shadow reviewer, the size's pick one effort lower.
  Rejected: raising only XS and M; no change until measured.
- Experiments? ✅ Shadow reviews and a writer A/B (rejected: shadow reviews
  only; none).
- Records?
  - ✅ Cumulative review tallies and online reviewers in usage
  - ✅ Attribution through token-max,
    kept after the maintainer first left it out, because the writer A/B
    compares cost and `quest usage` crashes on this host
  - Rejected: a PR-body hook that validates `## Models` and `## Caused by`
- Milestone? ✅ m0 (rejected: m1).

Readout, the agent's choices for the implementer to revisit:

- Start one week after both experiments are live. From `quest usage --json`,
  compute each arm's variance and the number of PRs each arm needs to
  detect a difference worth acting on. If the arms have not reached it,
  rewrite the `Waiting` item below for the date they will, and stop. XL
  quests are rare, so report how many each XL arm got rather than wait for
  a detectable difference there (user, 2026-11-13).
- `quest usage`'s `arms` rollup counts each sized PR whose every
  `Implementer:` line names the same arm, under its first line's writer,
  with every session's spend on it. Escapes are too rare to separate the
  arms (about 2% of PRs): report them alongside, not as the measure.
- For each writer arm, compare first-round findings from the fixed efforts in
  `src/cli/models.ts`, review rounds, hand-backs, later `## Caused by` culprits, and cost
  per merged PR. For each shadow pair, compare findings the routed reviewer
  raised that the shadow missed, and the reverse, along with fixed and
  refuted findings and cost per PR. A shadow finding that matches a routed
  finding on the same file, within a few lines, counts as found by both;
  check a sample of matches by hand before trusting the rule. The PR body's
  `## Review` record keeps only tallies and the latest findings, so read
  each finding's location from the branch's saved rounds under the clones'
  `.git/quest/review/`. Recommend each table change to the
  maintainer with its tally. End the writer A/B by deleting its arms from
  `src/cli/models.ts`, with `quest models --arm`, the `arm` field of
  `quest unblocked --json`, and the arm notes in the README, guide, and
  `/quest-run` and `/quest-iterate`. Keep the shadow reviewer only if the maintainer
  chooses to.
- Carry the tallies into [the model check](/quest/m1/model-check.md)'s
  baseline.
- Chart the arms' cost against quality as
  [the model check](/quest/m1/model-check.md)'s chart procedure describes,
  one point per arm, and link the charts with the recommendations. Its
  `quest usage --json` rows give each arm's cost per merged PR and
  first-round findings, and each shadow pair's cost and findings per PR.
  Only tallies begun after
  [moq-dev/quest#721](https://github.com/moq-dev/quest/pull/721) merged
  record a first round, so count first rounds only over those.

Baseline from the 2026-11-11 audit, at API list price:

- Host spend 2026-11-01 to 11-11: about $18.6k. Claude $15.7k, Codex
  $2.6k, Grok $0.2k (stopped 11-05), DeepSeek $14. `quest usage` traced
  only $5.2k (28%) to a PR. Sub-agent transcripts it does not read held
  about $1.5k of quest-branch work. Coordinator main sessions cost about
  $1.5k.
- Median writer cost per merged PR: XS $0.7, S $1.6, M $5.2, L $10.6, XL
  $21.7. Review cost per PR: Sol low $0.10, medium $0.20, high $0.67,
  xhigh $0.69. Local reviews were under 3% of spend.
- Sol findings per reviewed branch: low 0.03 (XS, 68 branches); S medium
  0.30 (176) against S high 0.67 (12); M medium 0.41 (177) against M high
  0.67 (3) and M xhigh 1.44 (9); L high 1.43 (35). Read from each branch's
  saved review rounds under the clones' `.git/quest/review/`, by the size
  and effort of its last round. About 90% of findings were fixed and 3-5%
  refuted.
- Escapes: 42 of 1,983 merged PRs (2.1%) were later named under
  `## Caused by`. That is a floor, since the convention began 11-04 to
  11-08. Of 30 sampled escapes, 6 were catchable from the diff, 17 maybe,
  and 7 needed runtime (nightly or platform lanes); 5 were races. Review
  scores are saturated: about 90% of PRs scored 9 or 10.
- Online reviewers:

  | Reviewer | Coverage of merged PRs | Findings accepted |
  |---|---|---|
  | CodeRabbit, moq | 44% (hourly cap) | 74%, 17% declined |
  | CodeRabbit, moq.pro | 0% (summaries only on the free plan) | none |
  | Pullfrog DeepSeek, moq | 88% | 89% |
  | Pullfrog GLM, moq.pro and quest | under 30% | mostly nits; removed |
  | The Dot (OpenAI, posts as the maintainer), moq | 95% | not measured |

  The Dot's model is undisclosed. About 11% of the PRs it reviews get
  `[P1]`-`[P3]` findings in its review body. About 40% of those PRs merged
  while its latest review still listed findings.

  The table predates Pullfrog's move to Claude (2026-11-12) and its review
  replacing the DeepSeek one in `quest review`
  ([token waste](/quest/m0/token-waste/README.md), 2026-11-13).

## Waiting

- moq-dev/quest: one week of PRs since both the shadow reviewer
  (`quest review`'s, PR titled "quest: run a shadow reviewer one effort
  below the routed one") and
  the writer A/B ([moq-dev/quest#720](https://github.com/moq-dev/quest/pull/720)) merged; check
  their merge dates with `gh pr list --state merged` and the day with `date`

## Related

- [Model check](/quest/m1/model-check.md) - retunes the tables each
  milestone from these tallies
- [Mistake audit](/quest/m0/mistake-audit.md) - files runtime escapes in
  their owning repositories
