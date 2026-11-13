# Quests

## Goal

Make Quest the way moq-dev's and Kixel's repositories plan and coordinate
work through versioned Markdown, with a standalone CLI their contributors
can run on a fork.

Non-goal: serving repositories outside them. Quest may depend on Kixel
Code.

## Plan

Decided 2026-11-13 (user, /quest-plan, unprompted, while planning
[the benchmark](/quest/m0/benchmark/README.md)): "I'm fine dropping quest
as a generic solution for now. The binary needs to runnable by
contributors, but it's a non-goal to have them use their own (non-fork)
repos". The Goal read "a reusable way to plan and coordinate repository
work... with a reversible adoption path" until then. m1's public-release
quests predate this and are due a `/quest-audit`.

`m0` is adoption on moq-dev's own repositories, `m1` the public release,
and `m2` later work. Add later horizons when concrete work warrants them,
keeping milestone numbers stable as earlier milestones complete.
