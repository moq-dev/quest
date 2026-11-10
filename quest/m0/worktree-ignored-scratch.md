# [M] Finished checkouts remove without --force

## Goal

`quest worktree remove` deletes a finished agent checkout without `--force`
whenever everything left in it is git-ignored build output or commits that
merged changes already hold. It still refuses anything that could be work:
modified or untracked files, commits nothing reaches or merged, nested
repositories, and submodule worktrees.

## Plan

Planned 2026-11-10 (maintainer, /quest-plan in moq-dev/moq.pro). Milestone:
✅ m0 (rejected: m1, drop).

A /quest-spawn run in moq-dev/moq.pro left 40 finished agent checkouts, and
`quest worktree remove` refused 38 of them, so the maintainer had to run a
`--force` pass. Two different causes:

- **Ignored build output (30 checkouts).** The scratch is fixed at creation by
  `derivedDefaults`, from the main checkout's top-level ignored entries, which
  there are only `.direnv` and `.scratch`. Agents' `node_modules`, `target`,
  `.terraform`, `app/.svelte-kit`, gate stamps and `.tmp/` are all ignored but
  not scratch, so they block removal.
  Decision: ✅ at remove time, treat every git-ignored path as scratch, except
  nested repositories and linked worktrees, which keep their own checks
  (rejected: a per-repository scratch list, which every repository must keep
  current; deriving from the checkout's own top-level entries at release,
  which still misses deeper paths). The nested-repository rule is what
  saved real work in that run: an uncommitted regression test sat in a
  submodule worktree under `.tmp/`.
- **Merged heads refused (7 checkouts).** Each refused commit was exactly the
  head of a PR that had merged through `quest land`, such as
  [moq-dev/moq.pro#3771](https://github.com/moq-dev/moq.pro/pull/3771) at
  `6bcb980f0`, yet `remove` reported "no merged change has as its head". Find
  why `merged` missed them (a landed squash, the forge query, or the claims
  lookup) and fix it, with a test on a checkout whose only unreached commit is
  a merged PR's head.

Public API: none. Wire: none.
