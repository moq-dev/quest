# [S] No nested epics

## Goal

`quest check` rejects an epic inside an epic: only a milestone holds epics,
and an epic holds only quests. The guide's Model section says so, and
`quest mv` can still flatten one by moving its quests up.

## Plan

Decided 2026-11-09 (user, /quest-plan): ✅ no nesting at all, since an epic
that needs a sub-epic is too large (rejected: a branch per nested level; a
branch for the top-level epic only). With one level, a quest's PR is always
one hop from `main`.

moq-dev/quest's own tree has no nested epic. Eleven exist elsewhere as of
2026-11-09: three each in moq-dev/moq, moq-dev/moq.pro and moq-dev/rind, one
each in moq-dev/kixel.ai and moq-dev/rust2. Each repository's pinned `quest`
runs `quest check` in its queue build, so the pin that carries this check
must not reach a repository before it has flattened.

## Waiting

- moq-dev/moq: flatten its three nested epics, planned with `/quest-plan`
  in its own tree. Check with
  `git ls-tree -r --name-only origin/HEAD quest | grep -E '^quest/m[0-9]+/[^/]+/[^/]+/README\.md$'`
  printing nothing, as for each repository below.
- moq-dev/moq.pro: flatten its three nested epics.
- moq-dev/rind: flatten its three nested epics.
- moq-dev/kixel.ai: flatten its nested epic.
- moq-dev/rust2: flatten its nested epic.
