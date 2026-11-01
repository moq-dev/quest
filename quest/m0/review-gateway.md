# [S] quest review routes through a gateway or cloud provider

## Goal

`quest review` works when the reviewer CLI reaches its model through a
gateway such as CLIProxyAPI, or through a cloud provider. The reviewer
keeps `ANTHROPIC_BASE_URL` with its token, `ANTHROPIC_CUSTOM_HEADERS`,
Claude Code's Bedrock, Vertex, and Foundry switches, and Codex's
`CODEX_ACCESS_TOKEN` and `CODEX_CA_CERTIFICATE`, instead of having them
stripped and being reported as logged out. Variables that would change the
reviewer's plugins, permissions, or configuration are still stripped.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], m0: pass these through instead of blocking them.

- `review()` runs the status check and every turn with
  `strippedEnvironment` (`src/cli/agent.ts`), which removes every
  `ANTHROPIC*` variable, every `CLAUDE*` one except `CLAUDE_CONFIG_DIR`,
  and every `CODEX_*` one except `CODEX_HOME`.
  Sessions whose credentials or endpoint came only from the environment got
  "claude is not logged in" (moq-dev/moq#7084, moq-dev/moq#7251).
- Reuse the tests from closed
  [moq-dev/quest#316](https://github.com/moq-dev/quest/pull/316), whose
  branch `fix/review-provider-environment`
  ([79fb7c4](https://github.com/moq-dev/quest/commit/79fb7c4cd45976184c5adc7adc286283b206231c))
  is still on GitHub: environment-only authentication for each reviewer and
  the cloud-routing cases. #316 also skipped Codex's stored-login check when
  `CODEX_API_KEY` is set, since that key works only for `exec` and
  `review`.
- Keep the managed agents' (`quest agent`) account isolation as it is. If a
  credential is still stripped on purpose, the error names the variable
  instead of saying "not logged in".
- This takes over the environment-credential part of
  [Review handles expired logins](/quest/m0/review-login.md), decided there
  on 2026-10-30 (user, ✅ extend that quest): let a reviewer keep the
  credential its own CLI reads from the environment, test it with a fake
  reviewer that authenticates only through an environment variable, and
  weigh each name against why `STRIPPED` exists. That decision also kept
  stripping variables that redirect billing; this one supersedes it for the
  gateway and provider variables in the Goal, which the maintainer routes
  reviews through on purpose.
