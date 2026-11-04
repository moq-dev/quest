# [M] Per-job opencode saved output

## Goal

No opencode job can read the tool output or shell captures another job
saved, whether in another repository or the same one. Each job saves them
in its own directory, deleted with the job's checkout. Sessions and the
account's credential, including a refreshed OAuth token, stay in the
account's database that every job on the account shares.

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

Decided 2026-11-04 (user, /quest-complete on
[moq-dev/quest#484](https://github.com/moq-dev/quest/pull/484)):

- Where should a job's sessions live?
  - ✅ The shared account database: every job keeps using the account's
    `opencode.db` through `OPENCODE_DB`, so the credential and its token
    refreshes stay shared. Only saved output (`tool-output`, `shell`) moves
    to the per-job directory.
  - Rejected: a per-job database with a copied credential, because
    concurrent jobs would each refresh their own copy, and where the
    provider rotates refresh tokens, one job's refresh invalidates the
    others'.

What opencode 2.1.1 keeps under `$XDG_DATA_HOME/opencode`, from its source
at tag `v2.1.1`:

- `opencode.db` holds both the sessions and the credentials (its
  `credential` table). `auth.json` is only a legacy file a migration imports
  once, so the credential cannot be linked in as a file. `OPENCODE_DB`
  overrides the database's path, resolved against the data directory unless
  it is absolute (`packages/cli/src/database-path.ts`), and the server
  honours it (`packages/cli/src/server-process.ts`).
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
- The launch sets `OPENCODE_DB` to the absolute path of the account's
  `opencode.db`. A relative name would resolve inside the job's directory
  and give the job an empty database without the credential.
- Account sign-in and status keep the account's own data directory.
- Nothing is in production, so existing accounts' shared data needs no
  migration.
- Extend `test/live/runner-sandbox.test.ts` with a second job, in the same
  repository, that tries to read the first job's saved tool output and shell
  capture.
