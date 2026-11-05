# [S] Cut a release with the worktree hooks

## Goal

A tagged quest release includes `quest worktree hook`, so SETUP.md's release,
mise, and installer routes give adopters a `quest` whose Claude Code hooks
work, and the release checklist says when the next one is due.

## Plan

Decided 2026-11-02 (coordinator, /quest-spawn follow-ups, after the user
asked the coordinator to decide follow-ups from evidence): plan it, [S], m1,
since every moq-dev repository pins quest through a nix flake and only
third-party adopters take the release routes.

Evidence, gathered 2026-11-02:

- The only release, v0.1.0 (`4fbbb0c0`, 2026-10-07), is 323 commits behind
  `main` and has no `worktree` command; the hook arrived in
  [moq-dev/quest#350](https://github.com/moq-dev/quest/pull/350) on
  2026-11-01. `SETUP.md` still offers those routes, and `quest init`
  installs hook entries that call it.
- No quest plans a release; m0's README only notes "v0.1.0 shipped".

Work:

- First, before any release: `SETUP.md` does not yet say v0.1.0 lacks the
  hook, so add that the release routes lack it and point at the flake
  route until a release has it.
- Once the remaining worktree-hook work
  ([moq-dev/quest#423](https://github.com/moq-dev/quest/pull/423); its
  sibling [#425](https://github.com/moq-dev/quest/pull/425) landed on
  2026-11-03) has landed or been dropped, bump `package.json`'s `version` in a PR to `main`, then tag that
  version from `main`; `.github/workflows/release.yml` publishes on the tag
  push and fails when the tag and `package.json` differ. Check that the
  release has the Windows archives SETUP.md expects, then drop the
  `SETUP.md` caveat.
- Check that the Install check (`.github/workflows/install-check.yml`, which
  Release calls) passes all 12 jobs on the new tag. Against v0.1.0 its 4
  Windows jobs fail because that release has no Windows assets ("No matching
  asset found for platform windows-x64", and a 404 for the archive):
  [run 40144909978](https://github.com/moq-dev/quest/actions/runs/40144909978)
  and [run 41660575051](https://github.com/moq-dev/quest/actions/runs/41660575051),
  as [moq-dev/quest#430](https://github.com/moq-dev/quest/pull/430)
  noted (coordinator, /quest-complete follow-ups, 2026-11-03).
- Decide in the PR how later releases are cut, such as a step in the release
  checklist or a recurring quest through `/quest-recurring`.
