# [S] Cut a release with the worktree hooks

## Goal

A tagged quest release includes `quest worktree hook`, so SETUP.md's release,
mise, and installer routes give adopters a `quest` whose Claude Code hooks
work, and later releases have a known cadence.

## Plan

[moq-dev/quest#587](https://github.com/moq-dev/quest/pull/587) bumped
`package.json` to 0.2.0 (pre-1.0 with breaking changes since v0.1.0, so a
minor bump) and made SETUP.md treat v0.1.0 as no release. What remains
follows the tag:

- Check the v0.2.0 release has the Windows ZIPs SETUP.md expects, and that
  the Install check (`.github/workflows/install-check.yml`, which Release
  calls) passes all 12 jobs; against v0.1.0 its 4 Windows jobs failed for
  lack of Windows assets
  ([run 40144909978](https://github.com/moq-dev/quest/actions/runs/40144909978)).
- Then drop SETUP.md's v0.1.0 caveat and the "next release" notes in
  README.md and docs/windows.md.

## Waiting

- Maintainer: push the `v0.2.0` tag from `main` once #587 merges, since
  CONTRIBUTING.md reserves release tags for the maintainer; check with
  `gh release view v0.2.0 -R moq-dev/quest`.
- Maintainer: decide how later releases are cut. Options: (a) a recurring
  quest via `/quest-recurring` that cuts a release every two weeks when
  `main` has user-facing changes, (b) a step in CONTRIBUTING.md's Releases
  section, (c) ad hoc. Recommend (a): the maintainer asked to start tagging
  releases, and a quest resurfaces in triage where a checklist line does not.
