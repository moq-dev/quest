# [L] Mistake audit

## Goal

Every week, the mistakes agents keep making in moq-dev's quest
repositories are grouped into classes, from the forge's records and the
maintainer's typed messages, and each class that recurred gets a follow-up
quest that fixes it at its source, for the maintainer's pick. Recurring;
nothing ends it.

## Plan

Decided 2026-11-09 (user, /quest-plan, from a comparison with
[pstack](https://github.com/cursor/plugins/tree/main/pstack)'s `/correct`
and `/reflect`):

- What does the plan cover?
  - ✅ The verification rule in `quest context` and this audit
  - Rejected: either alone
- A rule that agents settle by experiment what running something would
  answer, instead of asking?
  - ✅ Dropped: no typed message supported it. This audit measures the
    prompts first, below.
  - Rejected: planning it as stated; asking less by default, which
    reverses the guide's "block on user decisions"
- Which inputs?
  - ✅ The forge's records and the maintainer's typed messages, through
    `quest messages`
  - Rejected: forge records only; transcripts through a script each run
- What gates each run?
  - ✅ A week since the last run, the way
    the release cut waited. The decision named a
    `## Waiting` item because quests could not yet be held until a date;
    since `## Scheduled` exists, the run holds the date there (agent,
    2026-11-11).
  - Rejected: each milestone, as
    [the model check](/quest/m1/model-check.md) runs, since m0 has been
    open since 2026-09-26; each release cut
- Which milestone? ✅ m0 (rejected: m1)

Agent's choices, for the implementer to revisit. Each run:

- Read, since the last run's date: `quest usage --since <date> --json` in
  moq-dev/moq, moq-dev/moq.pro, and moq-dev/quest (each clone's root as
  `--root`), for each PR's review rounds, findings fixed and refuted,
  hand-backs, and the later PRs naming it under `## Caused by`; the diffs
  of those culprits and their fixes; and the typed messages from
  `quest messages --since <date> --json`.
- Read each culprit pair's `## Caused by` line before counting it. On
  2026-11-11 only 7 of 20 pairs were escapes: `fixedBy` takes every link
  in the section, including "No single PR" lines and unmerged PRs, until
  [the token-max attribution](/quest/m0/routing-evidence/usage-token-max.md)
  lands; the rest named a PR that left the work to a planned follow-up
  or kept older behavior.
- `quest messages` returns every human turn as a `kind: "message"` entry,
  beside the `kind: "answer"` entries tallied below, so set aside machine-written
  ones yourself: bare skill invocations, pasted relays and logs, accepted
  suggested prompts, and `/compact`, `/clear`, and `/goal` commands.
- Group them into classes by the agent behavior behind them. A class is
  the same behavior in two or more PRs or messages; one failure is not a
  class.
- Classify each escape named under `## Caused by` as catchable from the
  culprit's diff, including one a reviewer might plausibly have caught, or
  as runtime: a nightly-only or platform lane, or a test the gate skipped.
  Tag races separately; a race is runtime only when the diff does not show
  it. Each runtime class's follow-up belongs to the repository that
  owns that gate, so it goes in the run PR's `## Follow-ups` for
  `/quest-plan` there, as the guide's Creation section says (user,
  2026-11-11, [routing evidence](/quest/m0/routing-evidence/README.md)).
- Before proposing a fix, find the quest, check, or rule that already owns
  the class, and report whether its count fell since that landed. A rule
  whose class still recurs is the case for moving it up a level.
- Fix each class at the highest level that holds: a design change that
  removes the mistake, then a check whose message names the fix (a type,
  a lint, a hook, a command's refusal), then a test, and a prose rule
  last, only for a judgment call. A check's quest names a past PR or
  message it would have caught.
- Each fix is a follow-up quest in the run's PR, as the guide's Creation
  section describes, for the repository that owns it. The audit itself
  edits no `AGENTS.md`, `CONTRIBUTING.md`, or skill.
- Tally the decision prompts per skill: how often the answer was the
  agent's own recommendation. Propose a change only where that is nearly
  always. `quest messages --json` prints each answer as a `kind: "answer"`
  entry with the skill, the `recommended` options, and the `picked` ones.
- moq-dev/quest is public, and typed messages can name customers and
  private repositories. The PR and its quests give counts and classes in
  the agent's words, never a message's text, and name no moq-dev/moq.pro
  PR or path; quotes stay in `.tmp/`.
- Leave model and effort tallies to
  [the model check](/quest/m1/model-check.md).
- The run's PR rewrites this quest at this path, or at the same path in
  the lowest open milestone once m0 completes: the new baseline, what to
  check first, and a `## Scheduled` date one week after the run's date,
  checked with `date`.

Check first next run:

- Stalls after the stop hook of
  [moq-dev/quest#600](https://github.com/moq-dev/quest/pull/600) (landed
  2026-11-10T18:34Z): 3.8 per 100 typed messages after it against 6.5
  before, on only 27 hours and 3 stalls.
- Hand-run `/quest-complete` after `/quest-run`
  ([moq-dev/quest#608](https://github.com/moq-dev/quest/pull/608), landed
  2026-11-10T20:04Z): 6.6 a day in its first day against 5.2 before, with
  3 `/quest-run` runs; `/quest-spawn` fell from 4.1 to 0.9 a day.
- Output handed back unchecked, after the verification rule of
  [moq-dev/quest#625](https://github.com/moq-dev/quest/pull/625) landed
  2026-11-11T18:43Z: no data yet.
- Heads that landed past a finding or decision, after
  [late signals](/quest/m0/late-signals.md) lands.
- Whether moq-dev/moq and moq-dev/moq.pro planned the runtime follow-ups
  of moq-dev/quest's 2026-11-11 run PR, and whether their escapes recurred.

Baseline from the 2026-11-11 run (PRs updated 2026-11-09 to 11-11; typed
messages 2026-10-26 to 11-11, classed by one sub-agent, approximate):

- PRs: moq-dev/moq 194 (158 merged), moq-dev/moq.pro 150 (99), and
  moq-dev/quest 69 (59). Hand-backs: 4, 20, and 0. 57 of the 316 merged
  PRs record implementers that `quest usage` dropped
  until its Implementer parsing was fixed.
- Escapes: 7 real of 20 culprit pairs. Catchable 2, maybe 2, runtime 3;
  races 2 (one maybe, one runtime). All 7 culprits passed a local Sol
  review. The routing audit's sample of 30 earlier escapes split 6, 17,
  and 7, with 5 races.
- Landed past an open signal: 3 in moq-dev/moq, 2 catchable and 1
  maybe. A review finding posted after enqueue, a recorded decision the
  head lacked, and a red platform run. [Late signals](/quest/m0/late-signals.md) takes the
  first two; `quest merge`'s refusal of failed checks
  ([moq-dev/quest#601](https://github.com/moq-dev/quest/pull/601)) covers
  none of them.
- A scoped gate skipped a test the change reached, runtime: 2, one each in
  moq-dev/moq and moq-dev/moq.pro.
- A shell pipeline under `pipefail` whose reader exits early, a race: 1
  this week in moq-dev/moq.pro, its third fix there.
- Named a PR that deferred the work, or kept older behavior, as a
  culprit: 4 in moq-dev/moq; `quest context` now requires confirming
  the culprit in the blamed PR's diff.
- Typed mid-session messages, per 100, before 2026-11-09 (841) then after
  (131): stalls until nudged 6.5 then 4.6; proposals steered simpler 4.8
  then 0; misread intent 1.9 then 3.1; reported instead of fixed 0.7 then
  2.3; routine choices asked 3.4 then 1.5; answers that only picked the
  recommendation 7.7 then 3.8 (`/quest-plan` 11, `/quest-complete` 10,
  `/quest-spawn` 6, `/quest-iterate` 1, unknown skill 42). The after
  window is under 3 days.
- `quest messages` counts more than the 2026-11-09 hand scan: 1,088
  mid-session messages to its 579 over the same days, likely from the
  Codex and T3 Code threads and worktree directories it covers.

## Scheduled

- 2026-11-18 - one week after the 2026-11-11 run

## Related

- [Routing evidence](/quest/m0/routing-evidence/README.md) - the escape
  baseline and the runtime-escape split
- [Model check](/quest/m1/model-check.md) - tallies the same PR records by
  model and effort
