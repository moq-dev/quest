# [M] The review record tallies every round

## Goal

A PR body's `## Review` record shows, for each reviewer, the findings it
raised across every round on the branch, by severity, and how many were
fixed, refuted, or left open, beside the latest round it already shows.
`quest usage` reads those tallies, so its accuracy rollup counts every
finding caught before merge, not only the round before the latest.

## Plan

Decided 2026-11-11 (user, /quest-plan,
[routing evidence](/quest/m0/routing-evidence/README.md)). Today the record
keeps only the latest round. The review state under the clone's Git
directory holds every round, but only on the host that ran it.

Agent's choices, for the implementer to revisit:

- Keep one tally line per reviewer, such as
  `- Rounds: 3; findings 4 (high 1, medium 3): fixed 3, refuted 1, open 0`,
  computed from the saved session's rounds and their dispositions. A
  `--new` session continues the old one's tally, so restarting a reviewer
  does not reset its count.
- Drop `quest usage`'s "round before the latest" rule once the tally line is
  there. Leave older records, which have no tally line, uncounted, since
  nothing is in production.
