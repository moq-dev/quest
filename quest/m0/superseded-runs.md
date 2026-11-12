# [M] Ignore checks from superseded workflow runs

## Goal

`quest status`, `quest merge`, `quest wait` and `quest land`, including its
daemons, ignore the checks of a GitHub Actions workflow run that a newer
run replaced, as land-bump already does. A run that a newer run cancelled
then fails nothing, including a matrix job it left under an unexpanded name
such as `Tests (${{ matrix.os }})`. A cancelled run that nothing replaced,
and a failed run that is still its workflow's latest for its event, fail as
before.

## Plan

Decided 2026-11-12 (user, /quest-plan of the follow-ups from a
/quest-complete run on kixelated/token-max): ✅ drop the checks of replaced
workflow runs before picking each check's latest report (rejected: treating
a cancelled run as passing, since a genuinely cancelled required run would
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

- Share land-bump's rule rather than writing a new one. `latestRuns`
  (`src/cli/land-bump.ts`) keeps each workflow's latest run per event, and
  drops a cancelled run that a newer run of any event replaced, as when push
  and pull_request share a `cancel-in-progress` group. Its caller then drops
  the replaced runs' check suites. Move both into `src/github/checks.ts`, so
  status, `quest merge`'s refusal of a failed check (`passing` in
  `src/cli/hold.ts`), wait, land and land-bump all judge the same checks.
  Keep land-bump's tests passing.
- Read the runs through the existing check queries, as
  `checkSuite { databaseId status conclusion workflowRun { databaseId event workflow { databaseId } } }`,
  rather than land-bump's extra REST calls, unless GraphQL lacks a field
  the rule needs.
- Workflow-run fields need Actions read. `quest land serve` mints its API
  token with only `checks` and `statuses` read (`src/cli/land-serve.ts`).
  Add `actions: "read"`, which the GitHub App already grants, since
  land-bump and land-watch request it.
- Where dropping replaced runs leaves no checks, report pending, as
  land-bump does (`found.length === 0`). `checksState` returns success for an
  empty list, and status has no list of required checks to fall back on.
- Order runs so that a rerun of a replaced run counts as newest, for
  example by the latest attempt's start, rather than by run id. Otherwise
  rerunning the cancelled run, the only workaround today, is ignored.
