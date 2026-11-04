# [M] Per-job opencode data

## Goal

Each opencode job runs with its own opencode data directory, holding its
sessions, saved tool output, and shell captures, with only the account's
credential shared in. The directory is deleted with the job's workspace, so
no job can read what another job saved, whether in another repository or the
same one. A job's own launches still resume its session.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#480](https://github.com/moq-dev/quest/pull/480)). On opencode
2.x, every job on an account shares the account's `data/opencode`, and the
job plugin lets the read-only file tools read all of its `tool-output` and
`shell` captures (`savedOutput` in `src/runner/opencode.ts`). A job can
therefore read output an earlier job saved, such as private moq-dev/moq.pro
output from a job on a public repository.

- What should the quest's goal be?
  - ✅ A per-job data directory
  - Rejected: narrowing the plugin's read root to the current project's
    subdirectory, which still lets jobs on the same repository read each
    other's output
- Which milestone and epic?
  - ✅ m0's job sandbox, since the leak already crosses m0's private and
    public repositories
  - Rejected: m1's contributor sandboxing

Implementation guidance:

- Split what `accountDirectories` puts under the account's `XDG_DATA_HOME`:
  the credential store stays with the account, and each job's launches get
  a data directory under the job's workspace with the credential linked or
  copied in. Check which files opencode 2.x keeps there (`auth.json`, the
  session database, `tool-output`, `shell`) and which it rewrites, such as
  a refreshed OAuth token, which must reach the account's copy.
- `savedOutput` then names the job's own directories.
- Nothing is in production, so existing accounts' shared session data needs
  no migration.
- Extend the runner's sandbox test with a second job that tries to read the
  first job's saved output.

## Required

- [opencode 2.x](/quest/m0/opencode-sdk.md) - this builds on its client and job plugin
