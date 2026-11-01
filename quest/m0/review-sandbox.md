# [S] Live test that a reviewed head runs nothing

## Goal

An opt-in recipe runs `quest review` with the real Codex and Claude Code CLIs
on a head that plants configuration, and fails if any of it runs: a
`.codex/config.toml` MCP server, `.codex/hooks.json` hooks, an `.mcp.json`
server, and `.claude/settings.json` hooks. It also fails if the review writes
a trust entry for the reviewed directory into the reviewer's user config.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)).

- #271's fake-CLI tests check only that the isolating flags are passed. Its
  P1 (a trusted clone's worktree loading the head's `.codex/config.toml` MCP
  servers outside the sandbox) lived in CLI behavior that fakes cannot see.
- Each planted item records that it ran, such as a marker file or a request to
  a local port, and the test asserts nothing recorded. Run each CLI against a
  disposable config home that holds a login and trusts the reviewed clone, so
  the trust path is exercised.
- [openai/codex#49333](https://github.com/openai/codex/issues/49333) reports
  that `--ignore-user-config` skipping the project layer is a bug, and that
  the flag still writes a trust entry. Quest's protection relies on the
  former, so this test is what catches a Codex release that changes it.
- It needs real logins and spends API usage, so CI does not run it.
  [The review harness check](/quest/m0/review-harness.md) runs it each
  milestone, and anyone can run it after upgrading either CLI.
