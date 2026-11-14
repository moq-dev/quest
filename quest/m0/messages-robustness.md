# [S] quest messages reads transcripts it fails on today

## Goal

`quest messages` reads every Claude Code and Codex transcript the
maintainer's hosts write today, without failing on two shapes it refuses
now, while still failing on a shape it does not know.

- A malformed line in a Claude Code transcript, such as an interleaved
  partial record in the middle of the file, is skipped and counted, as
  token-max does, and the output says how many lines it skipped in which
  sessions. Today `parseLine` in `src/cli/messages.ts` throws on any
  complete line that is not JSON, the failure `quest usage` had before it
  read sessions through token-max.
- A Codex 0.162 TUI turn that carries `content_item_kinds` with no
  `content_item_metadata` provenance counts its `user.text` parts as
  typed and sets aside injected kinds, such as `agents_md.instructions`
  and `environments.environment_context`. A kind it does not know still
  fails, and the refusal stays for parts whose kind says nothing: all
  `unknown`, except a compaction replay.

## Plan

Decided 2026-11-13 (user, /quest-run, answering
[moq-dev/quest#704](https://github.com/moq-dev/quest/pull/704)): one quest
for both causes (rejected: a quest each; only the Codex one).

- Cause B was salvaged from the closed
  [moq-dev/quest#696](https://github.com/moq-dev/quest/pull/696). It failed
  `quest messages` on two of the maintainer's three hosts, in 4 and 21
  sessions, all from codex-tui 0.162.1. `readCodexMessages` accepts kinds
  only when all are `unknown`, and `test/messages.test.ts` expects
  `["user.text", "unknown"]` to throw; that expectation flips.
- Its PR lists under `## Caused by`
  [moq-dev/quest#626](https://github.com/moq-dev/quest/pull/626), which
  required provenance on every typed Codex turn. Cause A is as old as the
  reader.
- Reproduce each on a real transcript before fixing it.
