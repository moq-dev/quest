# [M] Per-job opencode data

## Goal

Each opencode job runs with its own opencode data directory, deleted with the
job's checkout, so no job can read the tool output, shell captures, or
sessions another job saved, whether in another repository or the same one. A
job's own launches still resume its session, and the account's credential,
including a refreshed OAuth token, stays the one every job on the account
uses.

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

What opencode 2.1.1 keeps under `$XDG_DATA_HOME/opencode`, from its source
at tag `v2.1.1`:

- `opencode.db` holds both the sessions and the credentials (its
  `credential` table). `auth.json` is only a legacy file a migration imports
  once, so the credential cannot be linked in as a file. `OPENCODE_DB`
  overrides the database's path (`packages/cli/src/database-path.ts`), and
  the server honours it (`packages/cli/src/server-process.ts`).
- `tool-output/` is flat, with no directory per project
  (`packages/core/src/tool-output.ts`). Only `shell/` has one
  (`packages/core/src/shell.ts`). Both keep files for 7 days. `log/` and
  `repos/` live beside them.
- A shared database's other sessions are out of a job's reach. The subagent
  tool resumes only a child of the current session
  (`packages/core/src/tool/plugin/subagent.ts`). Renaming or moving another
  session needs `tools.opencode.*` through `execute`, which `jobConfig`
  denies.

Implementation guidance:

- Put the job's data directory beside its checkout, as `<checkout>.review`
  is, and remove it in `Workspace.remove`. It must not go inside the
  checkout, which commands read and kix publishes. The runner's state
  directory, which commands cannot read, already holds it.
- The launch sets `XDG_DATA_HOME` to that directory. `savedOutput`, the
  `external_directory` rules, and the plugin's `reads` then name only this
  job's `tool-output` and `shell`.
- Where sessions live is the open decision under Waiting.
- Account sign-in and status keep the account's own data directory.
- Nothing is in production, so existing accounts' shared data needs no
  migration.
- Extend `test/live/runner-sandbox.test.ts` with a second job, in the same
  repository, that tries to read the first job's saved tool output and shell
  capture.

## Waiting

- Maintainer: where should a job's sessions live? A credential in opencode
  2.x is a row in the same `opencode.db` as the sessions, so "only the
  credential shared in" means either sharing the account's database or
  copying the credential.
  - Recommended: set `OPENCODE_DB` to the account's database for every
    launch. The credential and its refreshes stay live and shared, as they
    are today. Only saved output moves per job, and the other sessions stay
    out of reach of the job's tools, as described above.
  - Alternative: give each job its own database, seeded from the account's
    credential, and write a refreshed token back after each launch. Sessions
    become per job too, but concurrent jobs on one account each refresh
    their own copy. Where the provider rotates refresh tokens, one job's
    refresh invalidates the others'.
  - Check that it is done: the maintainer picks one, and the pick replaces
    this item in the Plan.

## Required

- [opencode 2.x](/quest/m0/opencode-sdk.md) - this builds on its client and job plugin
