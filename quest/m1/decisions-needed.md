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

Cleared 2026-11-08 (/quest-unblock): no open draft in moq, moq.pro, rind,
rust2 or quest carries `## Decisions needed` any more; the last one,
moq-dev/rust2#426, was rewritten to `## Waiting`.
