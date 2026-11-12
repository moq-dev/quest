# [M] Ignore checks from superseded workflow runs

## Goal

`quest status`, `quest merge`, `quest wait` and `quest land`, including its
daemons, stop failing a head on a check that a cancelled GitHub Actions run
left behind once a newer run of the same workflow exists on that head. This
includes a matrix job the cancelled run left under an unexpanded name, such
as `Tests (${{ matrix.os }})`. A completed check keeps today's rule, where
each check's latest report counts. A cancelled run that nothing replaced
still fails. All of these readers agree on the head's state.

## Plan

Decided 2026-11-12 (user, /quest-plan of the follow-ups from a
/quest-complete run on kixelated/token-max): ✅ drop the cancelled checks of
replaced workflow runs (rejected: treating every cancelled check as passing,
since a genuinely cancelled required run would then pass; fixing each
repository's workflow, since every repository would need it and token-max's
`edited` trigger is deliberate).

Decided 2026-11-12 (user, /quest-review design checkpoint): ✅ `quest status`
judges the base's required checks as `quest wait` does, with the same
exceptions, such as the gate's own `quest land` check. A cancelled
pull_request run can be replaced by a push run that lacks a PR-only required
job, and status would otherwise read success while land and wait read
pending (rejected: leaving it to the implementer; letting a cancelled run
yield only to a run of its own event, which fails the push/pull_request
race again).

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

- Drop only cancelled checks, not whole runs. Dropping a run because a newer
  run of its event exists would also drop passed checks that the newer run
  gated off, such as jobs an `edited` run skips by `github.event.action`.
- land-bump (`latestRuns` in `src/cli/land-bump.ts`) already treats a run
  that a newer run cancelled as replaced, and reads the head's runs over
  REST, which also sees a newer run that has no check runs yet. Share one
  rule with it where that stays simple.
- Workflow-run data needs Actions read. `quest land serve` mints its API
  token with only `checks` and `statuses` read (`src/cli/land-serve.ts`).
  Add `actions: "read"`, which the GitHub App already grants, since
  land-bump and land-watch request it.
- Count a rerun of the cancelled run as current, since rerunning it is the
  workaround today.
