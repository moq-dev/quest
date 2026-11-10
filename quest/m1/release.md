# [S] Cut a release with the worktree hooks

## Goal

A tagged quest release includes `quest worktree hook`, so SETUP.md's release,
mise, and installer routes give adopters a `quest` whose Claude Code hooks
work. Later releases follow [Cut a release](/quest/m1/release-cut.md).

## Plan

[moq-dev/quest#587](https://github.com/moq-dev/quest/pull/587) bumped
`package.json` to 0.2.0 (pre-1.0 with breaking changes since v0.1.0, so a
minor bump) and made SETUP.md treat v0.1.0 as no release. What remains
follows the tag, pushed on 2026-11-10 at 2572be9c (maintainer's pick,
/quest-unblock, pushed by the agent with the maintainer's login):

- Check the v0.2.0 release has the Windows ZIPs SETUP.md expects, and that
  the Install check (`.github/workflows/install-check.yml`, which Release
  calls) passes all 12 jobs; against v0.1.0 its 4 Windows jobs failed for
  lack of Windows assets
  ([run 40144909978](https://github.com/moq-dev/quest/actions/runs/40144909978)
  and [run 41660575051](https://github.com/moq-dev/quest/actions/runs/41660575051)).
- Then drop SETUP.md's v0.1.0 caveat and the "next release" notes in
  README.md and docs/windows.md.
