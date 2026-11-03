# [M] The public host-gate repositories follow moq to the merge queue

## Goal

Deploy GitHub's merge queue and the async fixer for moq-dev/quest, rind and
rust2. Each repository's `Queue` workflow checks one merge group at a time,
and its host daemon runs `quest land watch` with the existing fixer.
Verify a fork PR lands through the queue.

## Plan

Decided 2026-11-02 (maintainer): moq's live queue and fixer are proven;
convert the three other public host-gate repositories now. The scope is
quest, rind and rust2. The private repository stays on its host gate.

The migration introduces `.github/workflows/queue.yml` in each repository,
updates its landing documentation, and adds isolated runners and watcher
configuration in kixelated/nixos. Complete the operational cutover after
those workflows land:

- Keep the existing picks and their head SHAs; do not pick previously
  unqueued PRs or a head that moved after approval.
- Remove the leftover `quest:merge` labels from the old gate first, such as
  those on [moq-dev/quest#324](https://github.com/moq-dev/quest/pull/324) and
  [moq-dev/rust2#446](https://github.com/moq-dev/rust2/pull/446),
  [#442](https://github.com/moq-dev/rust2/pull/442) and
  [#437](https://github.com/moq-dev/rust2/pull/437), none of which has
  auto-merge armed. An older pinned `quest` still reads them as holds
  (decided 2026-11-02, user, /quest-plan; the pin itself is
  [Merge driver upkeep](/quest/m0/merge-driver-upkeep.md)'s).
- Require `Queue` and a serialized squash merge queue in each `main`
  ruleset, replacing `quest land` and the old PR-side checks. Keep the
  administrator emergency bypass; remove the fixer's direct-merge bypass.
- Activate the host's watcher configuration in place of each batching
  daemon, keeping its user, state directory and fixer launcher.
- Report the skipped `Queue` context on existing picked heads whose PR
  workflows predate it, then enqueue those exact heads.
- Verify each queue runs its merge-group checks and lands a PR. Verify a
  fork PR too, since GitHub now owns the fork landing path.
