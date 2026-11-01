# [XS] Keep tests independent of the caller's environment

## Goal

`just test` passes inside a Claude Code or Codex session and under any user
git configuration. `test/agent.test.ts` clears the caller's agent variables
(`CLAUDE_CONFIG_DIR`, `QUEST_WORKTREE_HOME`, `ANTHROPIC_*`, `CODEX_*`) before
it compares the environment it launches with, and every git fixture turns off
commit signing.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR /quest-complete run). Almost every merge agent in that run had to unset `CLAUDE_CONFIG_DIR`
before `just test` would pass, because the launched agent's expected
environment picked it up. Decide whether the launch itself should strip any
of these variables or only the test should. Name that choice in the PR.

Decided 2026-10-30 (user, /quest-plan of the follow-ups from
[moq-dev/quest#292](https://github.com/moq-dev/quest/pull/292)):

- Signing:
  - ✅ Fold it into this quest
  - Drop it
- `test/review.test.ts` commits its fixtures without `commit.gpgsign=false`,
  unlike `move`, `snapshot`, `landed`, and `start`. Under a global SSH
  signing config it fails with `cannot run ssh-keygen`, since the fixture's
  PATH lacks it. Turn signing off there, and check the other fixtures for the
  same gap.
