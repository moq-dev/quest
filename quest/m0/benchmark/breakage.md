# [M] Record what each merged PR broke

## Goal

Every breakage is recorded against the PR that caused it, with that PR's
tier, size, models, and the guardrails it passed, so the report answers
what broke, which layer should have caught it, and whether more or less
should have been spent on the culprit. A breakage is any of:

- a later PR naming it under `## Caused by`, which `quest usage` counts
  today;
- a revert of it;
- a merge queue entry or default-branch run it turned red;
- an incident a repository reports against it, such as a deploy rolled
  back or a page, through a command a deploy or alert can call.

Each breakage records how it was found (a check, a reviewer, the queue, a
canary, a person, a customer) and how long after the merge, since a
breakage a person finds costs more than one a check finds.

## Plan

Decided 2026-11-13 (user, /quest-plan): "keep stats about what we're
shipping to recalibrate. Like attributing risk/cost/effort/model and
identifying what broke. Then we can audit if more or fewer guardrails are
needed."

[Routing evidence](/quest/m0/routing-evidence/README.md) left runtime
escapes to each repository's gate quests. That stands for fixing them;
this quest only records them.

Agent's choices, for the implementer to revisit:

- Reverts and red runs come from the forge, which Kixel Code's index
  already reads; send what only `quest` knows, the `## Caused by` links
  and reported incidents, as records.
- An incident whose culprit is unknown is recorded open, and the fix's
  `## Caused by` closes it. Count open ones separately so they are never
  read as zero.
- Fix-forward counts the same as a revert. Augment's write-up warns that
  revert rate alone undercounts: "many defects are fixed forward or
  discovered later."
- Report a rate per class of change and per tier with its sample size, and
  no threshold: the maintainer decides what a rise means.
- Keep names of customers and private repositories out of anything this
  public repository's records or PRs show.

## Required

- [Send each session's record to Kixel Code](/quest/m0/benchmark/records.md) -
  the record type and the sending path breakage records reuse

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - classifies each escape as
  catchable or runtime every week
- [Reviewer test set](/quest/m0/benchmark/reviewer-eval.md) - replays these
  culprits against the reviewer
