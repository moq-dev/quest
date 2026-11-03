# Public release

## Goal

kix.quest opens to any maintainer: a third-party repository onboards itself,
contributor PR heads run safely on runners, and the themed site and launch
material announce it. Nothing here is needed for moq-dev's own repositories,
which m0 serves first.

## Plan

Decided 2026-10-30 (user, /quest-plan): m0 is adoption on moq-dev/quest,
moq-dev/moq, and moq-dev/moq.pro, hosted at quest.moq.dev and closed to
other owners. Work only third-party repositories need moved here, and the
earlier "Later work" milestone became m2.

- Where does the public launch live?
  - ✅ Move to kix.quest in m1
  - Stay on quest.moq.dev
  - Decide later

## Required

- [Open kix.quest](/quest/m1/open.md) - the Worker moves to kix.quest and any owner may enroll
- [Kix for any repository](/quest/m1/kix/README.md) - onboarding, read-only CI checks, contributor sandboxing, and the maintainer guide
- [Quest log theme](/quest/m1/theme/README.md) - an MMO-style identity, copy, board, landing page, and CLI output for the demo and launch
- [Launch material](/quest/m1/launch.md) - README, quickstart, demo, comparison, and launch-post drafts
- [Workers in a 5-minute cache](/quest/m1/worker-cache.md) - re-plan #276's worker/coordinator split and gate tickets, after confirming the cache premise
- [Cancelling a gate stops its active phase](/quest/m1/gate-signals.md) - SIGTERM/SIGHUP reach every process the gate owns, so Bash traps and GNU `time` can't defer cancelling a phase; unblocks moq-dev/moq.pro#3137
- [quest wait after a merge](/quest/m1/wait-merge-heads.md) - `quest wait` resolves a head that reached the branch by a merge into it
- [One PR's collection failure can't stall its fixer job](/quest/m1/fixer-isolate-failure.md) - errors stay on their PR, and a PR that keeps failing is set aside
- [Retire Decisions needed](/quest/m1/decisions-needed.md) - only `## Waiting` hands a draft back, once no open draft uses the old heading
- [Review harness check](/quest/m1/review-harness.md) - recurring each milestone: newest pinned review models, and the live sandbox test passes
