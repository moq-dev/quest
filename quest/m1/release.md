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

- Tag the next version from `main` once the open worktree-hook work
  ([moq-dev/quest#423](https://github.com/moq-dev/quest/pull/423),
  [#425](https://github.com/moq-dev/quest/pull/425)) has landed or been
  dropped; `.github/workflows/release.yml` publishes on the tag push. Check
  that the release has the Windows archives SETUP.md expects.
- Until a release has the hook, SETUP.md says the release routes lack it
  and points at the flake route.
- Decide in the PR how later releases are cut, such as a step in the release
  checklist or a recurring quest through `/quest-recurring`.
