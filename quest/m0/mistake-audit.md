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
  - ✅ A week since the last run, as a `## Waiting` item, the way
    [the release cut](/quest/m1/release-cut.md) waits
  - Rejected: each milestone, as
    [the model check](/quest/m1/model-check.md) runs, since m0 has been
    open since 2026-09-26; each release cut
- Which milestone? ✅ m0 (rejected: m1)

Agent's choices, for the implementer to revisit. Each run:

- Read, since the last run's date: `quest usage --since <date> --json` in
  moq-dev/moq, moq-dev/moq.pro, and moq-dev/quest, for each PR's review
  rounds, findings fixed and refuted, hand-backs, and the later PRs naming
  it under `## Caused by`; the diffs of those culprits and their fixes;
  and the typed messages from `quest messages --since <date> --json`.
- Group them into classes by the agent behavior behind them. A class is
  the same behavior in two or more PRs or messages; one failure is not a
  class.
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
  always.
- moq-dev/quest is public, and typed messages can name customers and
  private repositories. The PR and its quests give counts and classes in
  the agent's words, never a message's text; quotes stay in `.tmp/`.
- Leave model and effort tallies to
  [the model check](/quest/m1/model-check.md).
- The run's PR rewrites this quest at this path, or at the same path in
  the lowest open milestone once m0 completes: the new baseline, what to
  check first, and a `## Waiting` item for one week after the run's date,
  checked with `date`. The first run has no such item.

Baseline, from the hand scan of 2026-11-09 (typed messages from
2026-10-26 to 2026-11-10, classed by three sub-agents, counts unverified):

- 579 mid-session messages, about 227 machine-written, about 352 typed, 68
  of them corrections or redirects.
- Stalls until nudged: 17 typed, plus the coordinator relays that the
  stop hook of [moq-dev/quest#600](https://github.com/moq-dev/quest/pull/600)
  targets; check first whether they fell after it landed.
- A proposal the maintainer steered simpler: 10.
- Misread intent or target: 7.
- Output handed back without running or looking at it: 7, which
  the verification rule in `quest context` owns.
- Reports a problem instead of fixing it, or fixes an arbitrary top few: 6.
- Asks a routine choice: 4, beside 14 answers that only picked the
  recommendation.
- Repeated by hand: `/quest-complete` or `/quest-spawn` about 36 times,
  "any new PRs?" 15, and away mode entered 14 times. A session on
  2026-11-10 was already weighing one skill for the first; check what it
  planned before proposing anything.
- Forge, since 2026-11-06: 65 of 416 merged moq-dev/moq PRs and 14 of 80
  merged moq-dev/quest PRs carry "Caused by" in the body, a phrase search.
  Use `quest usage`'s parsed links instead.

## Related

- [Model check](/quest/m1/model-check.md) - tallies the same PR records by
  model and effort
