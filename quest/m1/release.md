# [S] Cut a release with the worktree hooks

## Goal

A tagged quest release includes `quest worktree hook`, so SETUP.md's release,
mise, and installer routes give adopters a `quest` whose Claude Code hooks
work. Later releases follow [Cut a release](/quest/m1/release-cut.md).

## Plan

`package.json` is at 0.2.1. The v0.2.0 tag stays a tag with no release: its
Release run failed on macOS, which
[moq-dev/quest#624](https://github.com/moq-dev/quest/pull/624) fixed.

Once the v0.2.1 release exists:

- Check it has the Windows ZIPs SETUP.md expects, and that the Install check
  (`.github/workflows/install-check.yml`, which Release calls) passes all 12
  jobs; against v0.1.0 its 4 Windows jobs failed for lack of Windows assets
  ([run 40144909978](https://github.com/moq-dev/quest/actions/runs/40144909978)
  and [run 41660575051](https://github.com/moq-dev/quest/actions/runs/41660575051)).
- Then drop SETUP.md's v0.1.0 caveat and the "next release" notes in
  README.md and docs/windows.md.

## Waiting

- Maintainer: once this bump merges, tag `main` as `v0.2.1` and push the tag,
  since CONTRIBUTING.md reserves release
  tags for the maintainer, so no agent pushes one; check with
  `gh release view v0.2.1 -R moq-dev/quest`
