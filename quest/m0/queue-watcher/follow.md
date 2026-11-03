# [S] Verify the public repositories' merge queues land PRs

## Goal

moq-dev/quest's, moq-dev/rind's and moq-dev/rust2's merge queues are shown
to land every kind of PR, including one from a fork. Fix whatever a first
merge group exposes, as moq-dev/quest's did. Then delete this quest.

## Plan

Decided 2026-11-02 (maintainer): moq's live queue and fixer are proven, so
quest, rind and rust2 convert now. The private repository stays on its host
gate.

The cutover was done on 2026-11-03 (user, /quest-complete):

- Workflows: [moq-dev/quest#397](https://github.com/moq-dev/quest/pull/397),
  [moq-dev/rind#266](https://github.com/moq-dev/rind/pull/266) and
  [moq-dev/rust2#457](https://github.com/moq-dev/rust2/pull/457).
- Host: [kixelated/nixos#19](https://github.com/kixelated/nixos/pull/19)
  was deployed through the host's `deploy/quest-land` branch, adding the
  `nixos-{quest,rind,rust2}-ci` runners in their own org runner groups and
  switching each daemon to `quest land watch`. The first merge group showed
  the runner's read-only cgroupfs refusing `quest gate`'s `cgroup.kill`,
  fixed in #19.
- Rulesets: each `main` requires only `Queue`, with a squash merge queue
  that builds and merges one entry at a time (`ALLGREEN`, 90-minute
  timeout). The moq-bot bypass is gone; role bypasses stay.
- No repository had an armed pick to carry over. rust2's gate landed
  [moq-dev/rust2#446](https://github.com/moq-dev/rust2/pull/446) and
  [#442](https://github.com/moq-dev/rust2/pull/442) before the switch.
  [#437](https://github.com/moq-dev/rust2/pull/437) conflicts and keeps a
  stale `quest:merge` label; it needs `/quest-iterate` and a new pick in
  rust2.
- moq-dev/quest landed
  [moq-dev/quest#400](https://github.com/moq-dev/quest/pull/400), which adds
  util-linux (`flock`, `script`) to the dev shell, since the NixOS runner has
  neither and its first merge groups failed the tests.
- The watcher handled its first drops as designed: the queue dropped
  [moq-dev/quest#324](https://github.com/moq-dev/quest/pull/324) for both
  runner gaps, the fixer traced each to the environment and re-enqueued it
  unchanged, and it landed on the third merge group.

rind's and rust2's first merge groups may hit similar runner gaps, since
GitHub's Ubuntu runners preinstall tools their dev shells may not declare.
By 2026-11-03 both had landed PRs through their queues
([moq-dev/rind#276](https://github.com/moq-dev/rind/pull/276) and later,
[moq-dev/rust2#467](https://github.com/moq-dev/rust2/pull/467) and later), so
only the fork case remains.

## Waiting

- Fork contributor: a PR from a fork lands through any of the three merge
  queues. Check with
  `gh pr list -R moq-dev/<repo> --state merged --json number,isCrossRepository`
  and the `merge_group` runs on its `<repo>-queue` runner. A maintainer can
  advance it by landing a PR of their own from a fork.
