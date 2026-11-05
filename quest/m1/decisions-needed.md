# [XS] Retire the ## Decisions needed heading

## Goal

Only `## Waiting` hands a draft back. The claim regex and the docs and skills
that name `## Decisions needed` beside it drop the older heading.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from the
2026-11-02 `/quest-complete` session, raised by
[moq-dev/quest#390](https://github.com/moq-dev/quest/pull/390)): ✅ plan it,
m1.

- Remove the old heading from `src/core/claim.ts` (its regex, `handedBack`,
  and `handBackWaits`, which makes every `Decisions needed` item the
  maintainer's) and every doc and skill that names both.

## Waiting

- moq, moq.pro, rind, rust2, quest: no open draft carries
  `## Decisions needed` (on 2026-11-04, 4 in moq, 5 in moq.pro, 2 in rind,
  3 in rust2, none in quest). Check with
  `gh pr list -R moq-dev/<repo> --state open --draft --json number,body` and
  search the bodies for the heading. To advance it, rewrite each to
  `## Waiting`.
