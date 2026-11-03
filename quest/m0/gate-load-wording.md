# [XS] Stop blaming Spotlight for a fresh macOS runner's load

## Goal

The gate's docs, comments and tests describe a freshly booted hosted macOS
runner's load without naming Spotlight's index as its cause, since
measurements ruled that out. The gate's behavior is unchanged.

## Plan

Decided 2026-11-03 (coordinator, /quest-complete follow-ups, under the
user's 2026-11-02 instruction to decide follow-ups from evidence): plan it,
[XS], m0.

Evidence, gathered 2026-11-03:

- [moq-dev/quest#430](https://github.com/moq-dev/quest/pull/430) turned
  Spotlight indexing off for whole macOS jobs, and the load stayed high or
  rose: Release x86_64 ran at 33.18 / 39.10 (1- and 5-minute load) against
  10.94 / 20.17 before. Something other than Spotlight's index keeps a
  freshly booted runner loaded. The quest was dropped and the workflow
  change reverted.
- The Spotlight explanation is still on `main` in
  `.github/workflows/check.yml:70`, `.github/workflows/release.yml:126`,
  `test/gate.test.ts:131`, `src/cli/gate.ts:373` and `README.md:940`
  ("Gate expensive commands").

Work:

- Reword each place to say that a freshly booted hosted macOS runner's load
  stays above its CPU count for the whole job, from work outside the job
  that the gate can't wait out. Name no cause. Keep the reason each
  check or test exists.
- `README.md` is user-facing: keep its example of a host where load comes
  from outside the gate.
