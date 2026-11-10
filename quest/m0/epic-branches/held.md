# [S] quest waiting lists the epics a quest holds back

## Goal

`quest waiting` lists each epic whose branch holds landed quests but cannot
land on `main`, with what holds it: a quest with a `## Waiting` section, a
quest nobody has started, or a conflict with `main`, and for how long.
`/quest-unblock` walks the maintainer through them and offers to move a
stuck quest out of its epic with `quest mv`, so the rest of the epic lands.

## Plan

Decided 2026-11-09 (user, /quest-plan), recorded in
[the epic](/quest/m0/epic-branches/README.md): ✅ `quest waiting` and
`/quest-unblock` handle a held epic (rejected: listing only; nothing new).
The user recalls questline branches blocking epics indefinitely with
nothing showing it.

- Rank held epics as `quest waiting` ranks its other items, by what each
  unblocks; the commits waiting on the branch are a tiebreak worth showing.
- `quest start` opens each epic's draft PR handed back with one
  `## Waiting` item naming the epic's directory, so `quest waiting` already
  lists every epic, with the same text; replace that with what holds it.
- A quest moved out lands on `main` on its own. Its open PR, if any, is
  retargeted or reopened against `main`; a renamed head branch closes a PR,
  so the claim moves with a new PR rather than a rename.
