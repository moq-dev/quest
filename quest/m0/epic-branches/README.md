# Epics land on main as one unit

## Goal

Every epic has a branch. Its quests' PRs target that branch, each reviewed
and picked on its own, and the epic lands on `main` as one PR once its last
quest has merged, so `main` never holds a half-finished feature and a
release can be cut from it at any time.

The epic finishes with an end-to-end run on moq-dev/moq.pro: an epic's
quests land on its branch, a quest moved out of a held epic lands on its
own, and the epic's PR lands on `main` through the queue. The guide's Model
and Execution sections and the README describe epic branches.

Non-goals: a branch per milestone, PRs based on one another's branches, and
a merge queue or watcher daemon per epic branch.

## Plan

Decided 2026-11-09 (user, /quest-plan), after a workflow audit of the hosts'
transcripts and the PRs merged 2026-10-10 to 11-09. The user's reason:
releases are much easier to cut when `main` has no half-completed features.
This reverses [moq-dev/quest#44](https://github.com/moq-dev/quest/pull/44)
(2026-10-02), which dropped questline branches because they "kept finished
child work off the trunk and made agents maintain intermediate branches and
umbrella PRs"; the user also recalls epics blocked indefinitely. The
decisions below answer both: no chain of bases, and no branch left to
drift.

Decision prompts, chosen options marked ✅:

- What "stacked PRs for epics" means:
  - ✅ An epic branch: quests PR into it, and the epic lands on `main` as
    one PR. Each quest keeps its own PR, so reviews stay separate.
  - Rejected: a linear stack or graph of PRs based on their blockers'
    branches. `main` would still receive the feature piece by piece, a
    quest with two blockers has no single base, and under squash merges
    every PR re-merges its base after each parent lands.
  - Rejected: stay on `main` and gate releases on unfinished epics.
- Which epics get a branch:
  - ✅ Every epic in every repository (rejected: opt-in per epic,
    recommended by the agent for the merge cost a long-lived branch pays;
    every epic in moq.pro only).
- Nesting:
  - ✅ No nested epics at all; an epic that needs one is too large
    (rejected: a branch per level; a branch for the top-level epic only).
    Done in [no nested epics](/quest/m0/epic-branches/no-nesting.md).
- How a quest's PR lands on the epic's branch:
  - ✅ The maintainer picks each one, and it merges straight in with no
    queue (rejected: land without a pick and pick only the epic,
    recommended by the agent to remove the pick wait; a queue and daemon
    per epic branch).
- Who keeps the epic's branch current with `main`:
  - ✅ Landing a quest's PR first merges `main` into the epic's branch,
    then the PR (user: "as part of merging a PR stack we merge in main
    too"), so the branch is never more than one quest behind (rejected:
    the watcher daemon syncs every epic branch; whichever agent notices;
    only when the epic lands).
- A quest that holds its epic back:
  - ✅ `quest waiting` and `/quest-unblock` handle it: the held epic is
    listed with what holds it, and the stuck quest can move out of the
    epic so the rest lands (rejected: listing only; nothing new).
- How the epic lands on `main`: the user has no preference. The agent
  chose ✅ squash, as every PR lands today, since a merge commit needs each
  repository's queue ruleset changed (rejected: merge commit, which would
  keep each quest's commit for blame and `## Caused by`). Revisit if
  culprit links to a whole epic prove too coarse.
- Milestone: ✅ m0 (rejected: m1).

Recommendations for the children, not settled:

- The epic's branch is its README's quest branch, `quest/<epic>/README`,
  created from `main` by the first `quest start` under the epic, which also
  opens the epic's draft PR into `main`. That PR is the README quest's PR
  and holds the epic's own work last.
- An epic already partly landed on `main` gets a branch for what remains;
  nothing migrates.
- A quest whose `Required` names a quest in another epic stays blocked
  until that epic lands on `main`.
- A `/quest-plan` or `/quest-audit` PR that edits an epic's quests targets
  the epic's branch once it exists, since the branch has already deleted
  the finished ones.
- Check that each repository's PR checks and online reviewers run on PRs
  whose base is not `main`.

## Related

- [Land through a serial merge queue](/quest/m0/queue-watcher/README.md) - the queue the epic's PR lands through
