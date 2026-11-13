# [XS] The gate's nested-scope tests leave no scope running

## Goal

`just test` leaves no `quest-gate-*.scope` running after it finishes,
pass or fail.

## Plan

Found 2026-11-12 on the maintainer's host: two gate scopes from a test
run on 2026-11-11 at 00:57 were still running 42 hours later, one holding
`just --justfile /tmp/quest-test-KEYeCs/justfile ... phase` and the other
`bun /tmp/quest-test-KEYeCs/nested.ts`. They match `test/gate.test.ts`'s
`nestedGate` and `phase` helpers, the tests around "is stopped when the
enclosing scope's owner kills it". Both were stopped by hand on
2026-11-12, so reproduce the leak before fixing it, per the rule.

Decided 2026-11-12 (maintainer, /quest-plan): ✅ plan it in m0
(rejected: m1).

Fix it at the root: a leaked scope means some path, a failed or
timed-out test included, ends without stopping the scope it bound, which
may also leak in real nested gates outside the tests.

## Hosts

- linux - only systemd scopes can leak
