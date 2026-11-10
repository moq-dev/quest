# [M] Landing a quest syncs its epic's branch with main

## Goal

`quest merge <pr> --land <sha>` on a PR whose base is an epic's branch first
merges `main` into that branch with the quest merge driver, then squashes
the PR into it, with no queue. It applies the same review and check rules
as a landing on `main`. A conflict the driver cannot resolve fails the
command and names the files, for the agent to resolve on the epic's branch.
The epic's own PR lands on `main` through the queue like any other, once
its last quest has merged.

## Plan

Decided 2026-11-09 (user, /quest-plan), recorded in
[the epic](/quest/m0/epic-branches/README.md): the maintainer picks each
quest's PR, it merges straight into the epic's branch, and that landing is
what keeps the branch current with `main`.

- Syncing on each landing means an epic branch drifts only while none of
  its quests land. When the epic's PR is picked, the usual rule applies: a
  conflicting head is merged with `main` before it is enqueued.
- A PR already open against the epic's branch conflicts with it after a
  sync as it would with `main`; nothing new handles that.
- `/quest-merge` and `/quest-run` say where a pick lands, and offer
  the epic's PR only once no quest of the epic remains.
- The land watcher's daemons serve one base each and stay on `main`; they
  ignore PRs into an epic's branch.

## Required

- [A quest's PR targets its epic's branch](/quest/m0/epic-branches/branch.md) - opens PRs against an epic's branch, which this lands
