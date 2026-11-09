# [M] Follow-ups land in the PR that found them

## Goal

A session that finds work worth a quest adds it to its own PR as a quest
file, placed and sized by the repository's rules, with every decision it can
make pre-answered by its recommendation and every open one listed with
options. The PR body's follow-ups section names each new quest and its open
decisions. When the maintainer picks to merge the PR, in `/quest-complete`,
`/quest-merge`, or any other client, they settle those decisions in the same
round; the answers are recorded in the quest files, and a dropped follow-up
leaves the PR, before it lands. No follow-up lives only in a PR body, and
none lands undecided.

## Plan

Decided 2026-11-08 (maintainer, `/quest-plan` in moq-dev/kixel.ai, planning
its software factory): ✅ "Follow-up quests are created in the PR and any
decisions are made as part of merging the PR? Like we're already running a
quest-complete session and can quest-plan follow-ups as part of the decision
to merge" (rejected: each follow-up landing behind a `Maintainer:` accept
item; landing ready with recommended answers; a separate draft plan PR per
follow-up). Why: "so many follow-ups get missed" while they live in PR bodies
until someone runs `/quest-plan` on them.

- This replaces the guide's "a suggested follow-up becomes a quest only
  through `/quest-plan`" and "only `/quest-merge` and `/quest-complete` plan
  follow-ups". `/quest-plan` stays for planning the user asks for.
- A PR that adds quests takes the maintainer's pick, never the standing pick
  `/quest-complete` gives a PR with no behavior change: a quest-only change
  would otherwise land unseen and get implemented, the same reason
  moq-dev/kixel.ai's nightly triage quests need a pick.
- The merge question carries the follow-ups' open decisions with the merge
  pick, in the guide's Questions form, so the round that merges is the round
  that plans; an answer such as "whatever you recommend" takes every
  recommendation.
- This quest is the user's ask to edit `assets/AGENTS.md` and `assets/skills/`
  that this repository's `AGENTS.md` requires. Expect changes to the guide's
  Creation and Execution sections and to the start, iterate, review, merge,
  complete, spawn, and afk skills; follow `quest guide prompting`.

Tests: none beyond `just check`; the change is prose, so its review weighs
whether each skill tells an agent the same thing.
