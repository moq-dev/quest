# [S] quest review covers only the branch's own change, on any checkout

## Goal

`quest review` reviews the change between the base's merge base and `HEAD`
(`origin/main...HEAD`) with both reviewers. A branch that is behind its
base gets no findings on the base's newer code, which reads as reverted in a
two-dot diff. It also reviews a detached `HEAD`, since a merge session
can't check out a branch another worktree already holds.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], m0.

- In [moq-dev/quest#337](https://github.com/moq-dev/quest/pull/337), round 1
  reported two findings on code that main had gained after the branch's
  merge base, which the branch did not touch. Claude's turn already asks for
  `<base>...HEAD` (`src/cli/review.ts`), but Codex's `codex exec review
  --base <base>` reviewed main's newer code. Give each reviewer the merge
  base itself, or whatever form makes both review only the branch's change,
  and test it with a branch behind its base.
- [moq-dev/quest#348](https://github.com/moq-dev/quest/pull/348)'s merge
  fixes were reviewed from a differently named local branch, because the PR's
  branch was checked out in another worktree. `review()` refuses a detached
  `HEAD` ("check out the branch to review") and keys the session state by
  the branch name. Accept a detached `HEAD`, and key its session so that
  later rounds on the same work resume it, for example by the PR or by a
  name passed on the command line.
