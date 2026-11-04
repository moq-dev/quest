# [XS] Split the rejected-login review test

## Goal

`test/review.test.ts` › "a login the API rejects fails as logged out,
whatever the status check said" passes within the default 5 s test limit
under full-suite load, because each rejected-login variant is its own test.

## Plan

Decided 2026-11-03 (coordinator, /quest-complete follow-ups, under the
user's 2026-11-02 instruction to decide follow-ups from evidence): plan it,
[XS], m0, since a test that times out under load can be judged flaky and
disabled by the land watcher, even after
[moq-dev/quest#468](https://github.com/moq-dev/quest/pull/468) kept base and
runner failures from counting.

Evidence, gathered 2026-11-03:

- The test loops over 5 variants, building a fixture and running
  `quest review` against the fake reviewers for each, all inside one test.
- The land fixer's full-suite run on
  [moq-dev/quest#408](https://github.com/moq-dev/quest/pull/408#issuecomment-6607816976)
  timed out on it after 5,388 ms. The file took 33 s for 24 tests there. It
  passed alone, and the whole suite passed with `--testTimeout=15000`.

Work:

- Turn the loop into `fakes.each` over the variants, keeping every
  assertion, so each test runs `quest review` once.
- Check the rest of the file for other tests that run `quest review` more
  than twice, and split them the same way.
- Don't raise the timeout: the repository's rule is to fix the cause, not
  mask it with timeouts.
