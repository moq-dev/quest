# [S] quest messages reads Codex TUI turns that carry only content kinds

## Goal

`quest messages` reads Codex 0.162 TUI sessions, whose user turns carry
`content_item_kinds`, such as `user.text` for typed text and
`agents_md.instructions` or `environments.environment_context` for
injected context, with no `content_item_metadata` provenance. It counts
`user.text` parts as typed, sets the injected kinds aside, and still fails
on a kind it does not know.

## Plan

Found 2026-11-12 while measuring [the epic](/quest/m0/ask-less/README.md)'s
baseline: the command failed on two of the maintainer's three hosts, 4
sessions on one and 21 on the other, every one `codex-tui` 0.162.1, so the
baseline was taken with those sessions removed from a copy of
`~/.codex/sessions`.

`readCodexMessages` in `src/cli/messages.ts` accepts `content_item_kinds`
only when every kind is `unknown`, a compaction's replay, and
`test/messages.test.ts` expects `["user.text", "unknown"]` to throw. Keep
that refusal for parts whose kind says nothing.

Caused by [moq-dev/quest#626](https://github.com/moq-dev/quest/pull/626),
which required provenance on every typed Codex turn.

## Related

- [Mistake audit](/quest/m0/mistake-audit.md) - reads typed messages from
  every host each week
