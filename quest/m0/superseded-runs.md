# [M] Ignore checks from superseded workflow runs

## Goal

`quest status`, `quest merge`, `quest wait`, `quest hold` and `quest land`,
including its daemons, judge a head's GitHub Actions checks only by the newest run of
each workflow on that head. A run that a newer run cancelled then fails
nothing, including a matrix job it left under an unexpanded name such as
`Tests (${{ matrix.os }})`. A cancelled run that is still its workflow's
newest run fails as before.

## Plan

Decided 2026-11-12 (user, /quest-plan of the follow-ups from a
/quest-complete run on kixelated/token-max): ✅ drop superseded runs where
`latestContexts` picks each check's latest report (rejected: treating a
cancelled run as passing, since a genuinely cancelled required run would
then pass; fixing each repository's workflow, since every repository would
need it and token-max's `edited` trigger is deliberate).

What happened: in kixelated/token-max, editing a PR body right after a push
starts an `edited` run, which cancels the push's `synchronize` run through
`cancel-in-progress`. The cancelled run's matrix job reports under its
unexpanded name, which no newer run reuses. `latestContexts`
(`src/github/checks.ts`) keys check runs by app and name, so it keeps that
job as the latest, and `quest merge` refused
[kixelated/token-max#75](https://github.com/kixelated/token-max/pull/75),
[#76](https://github.com/kixelated/token-max/pull/76) and
[#78](https://github.com/kixelated/token-max/pull/78) until the cancelled run
was rerun.

Recommendations:

- Before picking each check's latest report, drop the check runs of any
  workflow run that a newer run of the same workflow file and event
  superseded on the head. Newer means a higher run `databaseId`, and a rerun
  attempt counts as the same run. Keying by event keeps a `push` run and a
  `pull_request` run on the same head apart, since each tests something
  different.
- Every query that feeds `latestContexts` or `checksState` asks for
  `checkSuite { workflowRun { databaseId event file { path } } }`: status,
  land, land-bump, hold and wait. `quest wait` decides whether a run is
  still in progress in its own code, which must agree. `checks.ts` still
  says the Worker shares it, which has been stale since kix was deleted.
- A required check that only a superseded run reported, such as a renamed
  job, then counts as missing, which the base's required-check list already
  treats as pending.
