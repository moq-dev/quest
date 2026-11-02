# [XS] Retire the ## Decisions needed heading

## Goal

Only `## Waiting` hands a draft back. The claim regex and the docs and skills
that name `## Decisions needed` beside it drop the older heading.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan of the follow-ups from the
2026-11-02 `/quest-complete` session, raised by
[moq-dev/quest#390](https://github.com/moq-dev/quest/pull/390)): ✅ plan it,
m1.

- Waits until no open draft in a repository that uses quest carries
  `## Decisions needed`: search open draft PRs' bodies for the heading before
  starting, and rewrite any to `## Waiting` first.
- Remove the old heading from `src/core/claim.ts`'s regex, `handedBack`, and
  every doc and skill that names both.
