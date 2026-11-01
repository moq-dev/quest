# [S] Clean up stray skills and refresh outdated stubs

## Goal

The repository ships no stale skill text, and `quest init` brings a
repository's skill stubs up to date. `assets/skills/quest-merge.md` is
deleted, and `assets/skills/quest-close.md` is deleted unless something
still needs it. `quest init` rewrites a Quest-written stub of a current
skill that nobody edited but whose description or setup link is out of
date. A stub someone edited stays as it is.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], m0, including the stub refresh.

- `assets/skills/quest-merge.md` is an old copy of the merge skill, added in
  [moq-dev/quest#335](https://github.com/moq-dev/quest/pull/335). It still
  tells agents to wait for an automated review, and nothing in
  `src/cli/skills.ts` imports it. `assets/skills/quest-close.md` ("Abandon a
  quest or PR") is also not imported; `assets/skills/delete.md` replaced it.
  Check for any other reference before deleting either.
- The refresh was suggested in
  [moq-dev/quest#337](https://github.com/moq-dev/quest/pull/337), which
  recognizes a stub of any version by its shape (`STUB` in
  `src/cli/setup.ts`). Rewrite only stubs that match that shape exactly, so
  an edited stub or a user's own `quest-` skill is never touched.
- The refresh amends m0's "Upgrading never rewrites repository files"; the
  [milestone's Plan](/quest/m0/README.md) records it. `docs/getting-started.md`
  says "existing stubs stay as they are"; update it.

## Related

- [Stale skill stubs](/quest/m0/init-prune.md) - removes stubs of retired skills; this quest refreshes those of current ones
