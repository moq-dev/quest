# [XS] Fix the flaky rejected-login review test at its root

## Goal

`test/review.test.ts`'s "a login the API rejects fails as logged out,
whatever the status check said" passes reliably, including its
`(host CLAUDECODE, rejected in turn)` case, with the root cause fixed
rather than its assertions loosened.

## Plan

[#706](https://github.com/moq-dev/quest/pull/706) loosened the test's
status-check count assertion, yet it failed once more in
[#716](https://github.com/moq-dev/quest/pull/716)'s validation on a cut-off
line in the fake CLI's log, apparently a fake killed mid-append. Reproduce
the failure first, such as by running the case in a loop under load, then
fix the root: for example, make the fake write each log line atomically,
or have the test wait for the fake to exit before reading its log.
Restore any assertion #706 loosened if the root fix makes it hold again.

The fixing PR names #706 under `## Caused by` in its body, once the
implementer confirms #706's fix missed the root cause.
