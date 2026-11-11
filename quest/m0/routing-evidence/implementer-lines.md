# [S] quest usage reads the Implementer lines agents write

## Goal

`quest usage` and `quest review` read every `Implementer:` item in a PR's
`## Models` section the way agents write it: a model's display name maps
to its ID, and a missing effort reads as unknown. A line neither can read
fails loud: `quest usage` reports it on its PR instead of dropping it, and
`quest review` errors as it does for a line naming no model.

## Plan

The 2026-11-11 [mistake audit](/quest/m0/mistake-audit.md) found 57 of 316
PRs merged in moq-dev/moq, moq-dev/moq.pro, and moq-dev/quest since
2026-11-09 with a `## Models` record whose implementers `quest usage`
dropped, nearly all Claude Code sessions. `implementer()` in
`src/github/models.ts` matches the model as `[^,\s]+`, so it rejects
`Claude Code, Opus 5.5, <effort> effort` (36 lines, at every effort or
none),
`Claude Code, Claude Opus 5.5, ...` (9), `Claude, Haiku 5.5, ...`, and
`claude-haiku-5-5, effort not reported`. Every Claude row in usage's
accuracy by implementer, and so
[the writer A/B](/quest/m0/routing-evidence/writer-ab.md), is short.

Agent's choices, for the implementer to revisit:

- Map display names through the models `src/cli/models.ts` already lists,
  rather than ask agents to write IDs: a rule would be a prose fix for a
  mistake parsing removes.
- `quest review` avoids the latest writer by the model its line names;
  check whether `Opus 5.5` failing to match `claude-opus-5-5` let a head
  be reviewed by its own writer's model, and fix it with the same mapping.
- `implementers()` and `withModels()` in `src/github/models.ts` have no
  caller outside tests; delete them unless this work uses them.

## Related

- [Writer A/B](/quest/m0/routing-evidence/writer-ab.md) - extends the
  same line with each writer's arm
