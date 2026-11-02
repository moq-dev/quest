# [XS] Codex keeps a way to skip project config

## Goal

Codex offers a supported way to skip a project's `.codex/` layer while
keeping the user's config. Once a release has it and the review harness check
passes with it, `quest review` uses it instead of `--ignore-user-config`,
which drops the user's model provider and profiles, and this quest is
deleted.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [moq-dev/quest#271](https://github.com/moq-dev/quest/pull/271)).

- [openai/codex#49333](https://github.com/openai/codex/issues/49333) reports
  that `--ignore-user-config` also skips the project layer, unlike its help
  text. #271 relies on exactly that to keep a reviewed head's MCP servers and
  hooks from running. A fix that matches the help text would reopen that hole.
- Do not post upstream, on #49333 or a new issue; the maintainer declined.
  Only watch for the change.
- This quest waits on Codex. Check #49333 and Codex release notes each time
  ready work is triaged; the live sandbox test, `just review-sandbox`,
  catches a release that changes the behavior first.
