# [XS] Check the first automated release

## Goal

The first release the Release workflow cuts on its own is complete and
installable, and the docs stop treating v0.1.0 as the only release.

## Plan

[moq-dev/quest#708](https://github.com/moq-dev/quest/pull/708) made the
Release workflow cut a release for every merge to `main` that changes what
ships (see CONTRIBUTING.md's Releases section), as decided 2026-11-12 on the
[epic](/quest/m0/pin-bumps/README.md). Its first release exists only after that
PR merges. Once it does, check it:

- The release lists both Windows ZIPs that SETUP.md expects, beside the
  macOS/Linux tarballs, `SHA256SUMS`, and `quest-installer.sh`.
- Every job of the run's Install check passed. A failure ships its fix as the
  next release; fix it here and check that release instead.
- The release binary has `quest worktree hook`, the Goal of
  [the v0.2.1 cut](https://github.com/moq-dev/quest/blob/2a80c902/quest/m1/release.md):
  `quest worktree hook --help` exits 0.

Then drop SETUP.md's v0.1.0 caveat and the "next release" notes in README.md
and docs/windows.md, and delete this quest.

## Waiting

- moq-dev/quest: the Release workflow publishes its first automated release
  after #708 merges; check that `gh release list --repo moq-dev/quest` shows a
  release newer than v0.1.0, or run the Release workflow on `main` by hand.
