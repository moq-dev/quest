# [S] Fix the flaky logged-out review test

## Goal

`test/review.test.ts`'s "a login the API rejects fails as logged out" passes on every run, with the flake's root cause fixed rather than retried or skipped.

## Plan

- Known: during validation of [#685](https://github.com/moq-dev/quest/pull/685), a full `just test` run failed this test once; it then passed three reruns. #685 does not touch the code it covers.
- Reproduce it first, such as by running the test in a loop or under the full suite's load, then fix the cause in the test or the code it exercises.
- The maintainer chose: ✅ add a quest to reproduce the flake and fix it at the root cause (rejected: plan it only if it recurs).
