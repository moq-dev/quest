# [M] Record merge picks and skips on the PR

## Goal

A merge pick or skip, the maintainer's or a standing one, is recorded on
the PR itself, so no session asks it again. `quest status` prints it, and
every coordinator honors it: a pick holds until the PR lands or hands back
a decision, and a skip holds until the PR's head changes or the maintainer
lifts it. A skip whose head changed is asked once more, saying what
changed. A standing pick records the class it qualified under.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan,
[the epic](/quest/m0/ask-less/README.md)): ✅ a skip holds until the head
changes (rejected: until the maintainer lifts it; until the next day).

Today a pick lives in the asking session and its sub-agents' briefs, and a
skip "stands for the session" (`assets/skills/run.md`, `complete.md`), so
from 2026-10-20 to 11-13 345 merge-pick answers and 80 skips repeated one
already given for the same PR, and 325 PRs were asked about three or more
times.

Agent's choices, for the implementer to revisit:

- Record each as a PR comment opening with a fixed marker naming the kind,
  the head it was given on, and for a standing pick its class, beside
  [late signals](/quest/m0/late-signals.md)' "Maintainer decision"
  marker, rather than a label, which cannot carry the head. Only comments
  from accounts with write access count.
- GitHub auto-merge enabled on the current head stays the pick's record
  while it lasts; the comment covers the gaps, such as a PR waiting for
  `/quest-iterate`.
