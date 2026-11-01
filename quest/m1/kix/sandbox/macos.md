# [M] Verify the sandbox on macOS, then lift the approval gate

## Goal

The job boundary holds on a macOS runner under Seatbelt, and once it does, a
job resumes with another maintainer's answer without the runner owner's
approval: the approval step is gone from kix, the inbox, and the runner.

## Plan

- Rerun the hostile-repository boundary test from
  [moq-dev/quest#212](https://github.com/moq-dev/quest/pull/212) on
  macOS. Sandboxed commands must not reach the account's Keychain item
  (`security find-generic-password`), `/private/var/folders`, or another
  home, and the realpath'd `/private/tmp` directory must work as `TMPDIR`.
- Decided 2026-10-24 (user) on #212: the answer-approval gate stays until this
  verification passes. Then remove `approvedAt` handling from the runner, the
  approval decision from the inbox, and the hold from kix, and update the
  "until the job sandbox ships" comments in `cloudflare/README.md`,
  `cloudflare/src/jobs/routes.ts`, and `store.ts`.
- Decided 2026-10-27 (user) in `/quest-plan`: rerun the test for an opencode
  account too, through its srt command wrapper, and lift the gate only once
  both agents hold.
- If the boundary does not hold, record what leaks here and keep the gate.

## Required

- [opencode sandboxing](/quest/m0/kix/sandbox/opencode.md) - opencode jobs' commands run in the same sandbox as Claude Code's
