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
- [Current landing status](/quest/m1/status-landing.md) - `quest status` drops a stale `landing-stopped` line and ignores superseded cancelled checks
- [Delete the legacy hold labels](/quest/m1/legacy-labels.md) - condition: every gated repository pins quest past #326; then only `quest:active` and `quest:kix` are holds
