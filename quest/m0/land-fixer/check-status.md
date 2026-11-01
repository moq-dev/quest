# [S] The gate shows queue status in its required check

## Goal

Each queued PR's required `quest land` check run shows where the PR stands:
queued at a position, waiting on named checks, in a batch, parked for the
fixer, or behind a halted queue. The gate only ever sets that check to queued
or in progress. It never marks it completed, so GitHub's auto-merge can never
fire around the gate.

## Plan

Decided 2026-11-01 (user, settling
[moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)'s decision 7,
[record](https://github.com/moq-dev/quest/pull/355#issuecomment-6561562421)):
"Comment once, but should plan using the require Github check for status? If
possible?" Triage posts the one comment; this quest is the check-run part.

It is possible. The App already owns the required `quest land` check name;
the rulesets require it, and nothing reports it today. The App can create a
check run with that name on each queued PR's head and update its `status`
(`queued` / `in_progress`) and `output.title` and `output.summary`. While no
conclusion is ever set, the required check stays unsatisfied. The gate keeps
landing through its own push or the pinned squash merge, as now.

- One check run per pinned head, updated in place; a new head gets a new run.
- Never set `conclusion`: a `success` would let auto-merge land the PR
  without the gate, and any other conclusion would read as a failure.
- Needs the App's `checks: write`, an installation permission the maintainer
  accepts. Check it during this work; it may already be granted for the
  existing check.
- [Fixer comments](/quest/m0/land-fixer/comments.md) explain decisions on
  the PR; the check run shows state only.

## Related

- [A PR whose own CI fails is parked](/quest/m0/land-fixer/ci-park.md) - one of the states shown
- Batch triage ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)) - added the parked, waiting, and halted states
