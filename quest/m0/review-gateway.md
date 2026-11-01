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

- [moq-dev/quest#339](https://github.com/moq-dev/quest/pull/339) lets a
  reviewer keep the credential its own CLI reads from the environment, and
  passes `CODEX_API_KEY` when `codex login status` fails. It still strips the
  variables that send requests to a gateway or another provider, and blocks
  credentials while one is set, as the review-login quest's 2026-10-30
  decision asked. That decision kept stripping variables that redirect
  billing. This one supersedes it for the gateway and provider variables in
  the Goal, because the maintainer routes reviews through them on purpose.
- Reuse the gateway and cloud-routing tests from closed
  [moq-dev/quest#316](https://github.com/moq-dev/quest/pull/316), whose
  branch `fix/review-provider-environment`
  ([79fb7c4](https://github.com/moq-dev/quest/commit/79fb7c4cd45976184c5adc7adc286283b206231c))
  is still on GitHub.
- Keep the managed agents' (`quest agent`) account isolation as it is. If a
  credential is still stripped on purpose, the error names the variable
  instead of saying "not logged in".
