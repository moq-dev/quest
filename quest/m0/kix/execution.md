# [L] Spawn and iterate work from decision prompts

## Goal

A maintainer starts ready work through kix.quest, follows it through agent
summaries, answers its questions, and receives a normal contribution PR. New
PR notifications present useful next actions, including explicitly
requested iteration, in the same decision UI.

## Plan

Decided 2026-10-20 (user) from the transcript audit recorded in
[quest start](https://github.com/moq-dev/quest/blob/d265755/quest/m0/helpers/start.md). Locally the user runs
`/quest-spawn next 16` or `next 32` twice a day per repository, only ever
asks for more parallelism, and accepts the recommended option 73% of the
time:

- Decided (user): start ready work as `/quest-spawn` does. Whenever a runner
  slot frees, take the next unclaimed ready quest in `quest unblocked`
  order, optionally scoped to milestones per project. The job's first step
  checks the quest is worth starting now; a doubtful one becomes a decision
  (start, skip, deprioritize, delete) instead of running.
- Decided (user): parallelism has no user-facing limit. Free runner slots
  and account quota cap it. Conflicts are prevented by ownership only: one
  owner per quest and per PR, recorded on GitHub. Overlapping files are left
  to the merge step, with no path declarations or overlap prediction.
- A start job claims through the bot exactly as `quest start` does: a draft
  PR. kix treats PRs that local sessions hold as owned, shows that owner on
  the card, and never acts on them: a `quest:*` label, or a draft with no
  `## Decisions needed` section. The inbox already lists such a draft, or a
  PR whose observation shows a `quest:*` label, as in progress, with no
  actions; showing the owner remains. A stale one is offered to the
  maintainer for takeover.
- A PR with no `quest:*` label that is ready, or a draft with
  `## Decisions needed`, is a decision item offering the
  `/quest-complete` actions, one decision per PR: mark ready, merge (merging
  directly or through a merge job already ship), iterate, skip, or delete. Owned
  PRs never push a notification.
- Each job's suggested follow-ups become a "plan these?" decision: the
  runner's `deliver` tool reports them, and the inbox offers a planning
  interview on them. Start and iterate jobs report theirs the same way.

Earlier guidance:

- Use the same runners, prompt contract, and publisher as planning instead
  of a separate agent orchestration stack.
- Apply quest-spawn selection/readiness behavior, including the
  `quest unblocked` within-milestone impact ranking, and the existing
  quest-start/quest-iterate workflows. A project opt-in authorizes eligible
  ready default-branch quests; explicit UI selection can prioritize work.
  Draft or blocked plans and already active/open work are not started again.
- Each job owns a recoverable checkout inside the project's Nix devShell and
  runs applicable checks. Checkpoint and release at blocking handoffs and job
  completion, restoring on resume with unresolved work and check results.
  The product does not replace a project's GitHub CI.
- Questions and significant findings pause into the UI with context,
  recommendations, and choices. Explicitly selected revisions resume the
  relevant session/PR with fresh authorization.
- Preserve results when the agent stops, fails, its account hits a limit,
  or its runner goes offline. Report the actual state and next action; do
  not mask failures with repeated runs.
- Stop implementation at PR delivery. Subsequent review/iteration/merge
  choices are explicit maintainer actions, with GitHub enforcing its normal
  review and merge rules. Independent donated reviews and CI come later.
- Cover the real prompt loop in integration tests, including simultaneous
  starts, a stale PR head, a blocked decision, an exhausted account, and a
  runner going offline mid-job.

## Required

- [Job sandbox](/quest/m0/kix/sandbox/README.md) - safe iteration on PRs with contributors' commits
