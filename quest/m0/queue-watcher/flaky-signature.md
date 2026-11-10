# [S] A flaky test's second verdict finds its first

## Goal

Two flaky verdicts on one test count as two, however the fixer worded each
failure, so the watcher opens the disabling PR at `FLAKY_VERDICTS`. A test
shows that the wordings seen on moq-dev/moq match one record.

## Plan

Found 2026-11-09 by a workflow audit of moq-dev/moq's queue, 2026-11-03 to
11-10: 29 of 82 failed `merge_group` builds were flaky tests, the fixer
gave 15 flaky verdicts, and the watcher opened no disabling PR.
`moq-transcode tests::live_multi_rung` had four verdicts and
`release.test.ts` "JSR token reaches only deno publish" two.

`recordFlaky` (`src/cli/land-watch-flaky.ts`) finds a test's record by
`signature(failure)` (`src/cli/land-fix.ts`), which only strips quotes and
collapses whitespace. The fixer wrote one test as both
`cargo nextest run --locked --tests: moq-transcode tests::live_multi_rung`
and `moq-transcode tests::live_multi_rung`, so each verdict started a new
record. The watcher's state directory is on the host; confirm there that
this is the only cause before fixing it.

Recommended: the fixer is already told the known flaky tests and the
signature to reuse (`KNOWN_BYTES`), so make that reuse hold, for example by
having it return the known entry rather than retype it, and name a new
failure by its test alone, without the command that ran it. No single PR
caused this: the matching is as old as the flaky record
([moq-dev/quest#406](https://github.com/moq-dev/quest/pull/406)).
