# [S] The watcher refuses fork picks for a private runner

## Goal

`quest land watch` can refuse a pick whose head is in a fork before it pushes
the `quest-queue/<base>/<number>` branch, so a fork's code never reaches a
repository's private queue runner. The refusal says why on the PR and leaves
the pick for the maintainer, as other refused picks are.

Only a check outside the PR's own code stops a malicious fork: the queue
branch's push runs the merged PR's own workflow, so a fork can rewrite any
refusal that lives there. moq-dev/moq.pro's `Refuse fork heads` job in
`main-queue.yml` stays only as the in-repo message for a mistaken pick.

## Plan

Decided 2026-11-09 (maintainer, /quest-complete of
[moq-dev/quest#580](https://github.com/moq-dev/quest/pull/580)): ✅ the watcher
refuses fork picks (rejected: keep only moq.pro's job as a guard against
mistaken picks; drop the job), after Codex's review of
[moq-dev/moq.pro#3772](https://github.com/moq-dev/moq.pro/pull/3772) found
that job candidate-controlled.

- Make it opt-in per watcher instance, such as a `--refuse-forks` flag: the
  public repositories (moq-dev/quest, rind, rust2) land fork PRs through the
  same watcher, and their runners are hardened by
  [Harden the queue runners](/quest/m0/queue-watcher/runners.md) instead.
- Decide from the PR's `headRepository` as the watcher already reads it
  (`src/cli/land-watch.ts`): a head outside the base repository, or a deleted
  head repository, is a fork. Refuse before the queue branch is pushed, with
  the message the old gate used, `fork pull requests cannot use the private
  runner`.
- Turn it on for moq.pro's instance in kixelated/nixos's quest-land module.
