# [S] Checks are judged by their latest run on the head

## Goal

`quest status`, `quest wait`, and the `quest land` gate judge each check on
a PR's head by its latest run, as GitHub's required-check rollup does. An
older run that a newer run of the same check replaced no longer prints,
counts, wakes a wait, or fails the gate, whether it was cancelled, failed,
or passed. `quest status`'s `checks` state follows those latest runs, not the
rollup's own `state`, which counts every run. The Worker's job context for a
PR reports checks the same way.

## Plan

Decided 2026-11-02 (maintainer): plan it in m1. Raised by
[moq-dev/moq#7325](https://github.com/moq-dev/moq/pull/7325), release-plz's
release PR. Each refresh pushes and edits the description at once, starting
two `Release gate` runs, and concurrency cancels one. The cancelled run's
gate fails on purpose; the other run on the same head passes, and GitHub's
merge state counted the pass (CLEAN). `quest status` still printed
`check failing required failure … Release gate`, which misleads merge
decisions. Split from [Current landing status](/quest/m0/status-landing.md),
which owned a one-line version of this in m0. The maintainer's newer m1 pick
for the fuller outcome moved it here.

Evidence on #7325's head `a15652d`, read 2026-11-02:

- The rollup's `contexts` list both `Release gate` check runs, from the same
  app (GitHub Actions), both `isRequired`. Check suite `112631417489`
  (run [41564598600](https://github.com/moq-dev/moq/actions/runs/41564598600))
  has the failure, started 02:12:02Z, and a cancelled `Scope`. Check suite
  `112631424074` (run [41564601164](https://github.com/moq-dev/moq/actions/runs/41564601164))
  has the success, started 02:34:46Z.
- The rollup's own `state` is `FAILURE`, and its
  `checkRunCountsByState` counts the cancelled and failed runs.
- REST `commits/{sha}/check-runs?filter=latest` returns both runs too. It
  keeps only the latest run per check suite, so it collapses a job's re-runs,
  not separate workflow runs.
- GitHub does not document which run counts. "About protected branches" only
  says duplicate job names across workflows give ambiguous results. The
  observed rule is that the newer run of the name, from the app, counts.
- `gh pr checks` keeps the run with the latest `startedAt` per check name,
  workflow name, and event (`eliminateDuplicates` in cli/cli's
  `pkg/cmd/pr/checks/aggregate.go`).

Where checks are judged today:

- `summarize` in `src/cli/status.ts` classifies every context with
  `classifyCheck` and prints `rollup.state` as the `checks` state.
- `quest wait` (`check` and `checkActivities` in `src/cli/wait.ts`) reads
  every context, so a superseded failure can wake it with `checks:failed`.
- The gate's `checks` in `src/cli/land.ts` fails a name when any of its
  reports fails: "A name reported twice, as by a rerun, counts only once
  every report passes", from
  [moq-dev/quest#229](https://github.com/moq-dev/quest/pull/229). Reverse
  it. GitHub merges that head, so the stricter rule rejects PRs GitHub
  accepts, such as each release PR that hits this race.
- `readTarget` in `cloudflare/src/github/service.ts` gives a job's agent
  every run and the rollup's `state`.

Decisions made while planning, for review in the PR:

- One helper both builds import keeps the latest contexts. Put it in
  `src/github/` (the Worker already imports `src/github/merge.ts`), not in
  `src/cli/status.ts`. Status, wait, land, and the Worker filter through it
  before classifying.
- Key a check run by its app (`checkSuite.app.databaseId`) and name. That is
  the identity a required check has in branch protection and rulesets, and
  the one `quest land` already matches a requirement on. Key a commit status
  by its context. A check run and a status with the same name stay separate,
  since GitHub requires both. Rejected: `gh pr checks`' key of name,
  workflow name, and event. It can keep two runs that GitHub's requirement
  counts once, so the list would disagree with mergeability.
- The latest check run is the one created last, the highest `databaseId`.
  A newer run that is still queued has no `startedAt`, but it already makes
  the check pending. The latest status is the one created last.
- The `checks` state is derived from the latest contexts: `failure` if any
  fails, else `pending` if any is pending, else `success`. With no rollup it
  stays `-`. Keep the line's format; update the README's `checks` row, which
  says it is the rollup state.
- Only the latest runs count toward `passed=`, and only they print as
  `check failing` or `check pending` lines.

Tests:

- A fixture recorded from #7325: a suite with a cancelled `Scope` and a
  failed `Release gate`, and a newer suite where both passed. `quest status`
  prints `checks success` with no failing line. `quest wait` never reports
  `checks:failed` for it and reports `checks:passed` once the head is idle.
  The gate counts the head passing. The Worker's job context lists the newer
  runs only.
- A newer queued run of a passed check makes it pending. A newer failure
  after a pass fails. The same name from two apps counts twice, and a check
  run and a status that share a name both count.

## Related

- [Current landing status](/quest/m0/status-landing.md) - the other half of the old quest: `quest status` drops a stale `landing-stopped` line
