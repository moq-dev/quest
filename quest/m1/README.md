# Public release

## Goal

kix.quest opens to any maintainer: a third-party repository onboards itself,
contributor PR heads run safely on runners, and the themed site and launch
material announce it. The standalone CLI runs on native Windows, whose suite
passes nightly rather than on every pull request. Nothing here is needed for
moq-dev's own repositories, which m0 serves first.

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

- [User state in their RunnerHub](/quest/m1/user-state.md) - each user's runners, jobs, inbox, and push subscriptions live in their Durable Object, and D1 keeps repository data and other cross-user state
- [Open kix.quest](/quest/m1/open.md) - the Worker moves to kix.quest and any owner may enroll
- [Release with worktree hooks](/quest/m1/release.md) - tag a release that has `quest worktree hook`, so SETUP.md's release routes work
- [Kix for any repository](/quest/m1/kix/README.md) - onboarding, read-only CI checks, contributor sandboxing, and the maintainer guide
- [Quest log theme](/quest/m1/theme/README.md) - an MMO-style identity, copy, board, landing page, and CLI output for the demo and launch
- [Launch material](/quest/m1/launch.md) - README, quickstart, demo, comparison, and launch-post drafts
- [Workers in a 5-minute cache](/quest/m1/worker-cache.md) - re-plan #276's worker/coordinator split and gate tickets, after confirming the cache premise
- [Retire Decisions needed](/quest/m1/decisions-needed.md) - only `## Waiting` hands a draft back, once no open draft uses the old heading
- [Bun EFAULT report](/quest/m1/bun-efault.md) - report concurrent `rmSync` `EFAULT` on Windows, and drop the workaround once Bun fixes it
- [Model check](/quest/m1/model-check.md) - recurring each milestone: the built-in implementation and review tables use the newest models at efforts retuned from outcomes, and the live sandbox test passes
