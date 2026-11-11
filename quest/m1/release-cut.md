# [S] Cut a release

## Goal

Every two weeks, when `main` has user-facing changes since the last tag, a
new quest release ships with its version bumped, so adopters on the release,
mise, and installer routes stay current. Recurring; nothing ends it.

## Plan

Decided 2026-11-09 (maintainer, /quest-complete of
[moq-dev/quest#587](https://github.com/moq-dev/quest/pull/587)):

- How are later releases cut? ✅ This recurring quest, every two weeks, when
  `main` has user-facing changes (rejected: a step in CONTRIBUTING.md's
  Releases section; ad hoc). A quest resurfaces each time ready work is
  triaged; a checklist line doesn't.
- Where is the two-week gate? ✅ A `## Waiting` item (rejected: a Plan line).
  Quests can't be held until a date, so a Plan line would let a spawn claim
  the quest only to find it too early, while coordinators check outside
  conditions before starting and `quest waiting` lists them. Each run's PR
  resets the item to the new release's date when it recreates the quest.

Each run:

- If the commits from the last tag to `origin/main` hold no
  user-facing change (only `quest/`, CI, tests, or chores), skip the cut and
  recreate the next run.
- Bump `package.json` by semver's 0.x convention: minor when the range has a
  breaking (`!`) commit, patch otherwise. List the user-facing changes in the
  PR body.
- The tag push stays a maintainer step, since CONTRIBUTING.md reserves
  release tags for the maintainer; agents cannot push them. The PR rewrites
  this quest to the checks that follow the tag, with a `Maintainer:` item to
  push `vX.Y.Z` from `main` after merge, checked with
  `gh release view vX.Y.Z -R moq-dev/quest`.
- After the tag, check that the release has every archive SETUP.md names and
  that the Install check (`.github/workflows/install-check.yml`) passed all
  its jobs on the Release run. Plan a quest for any failure.
- The PR that finishes those checks deletes this run and creates the next at
  this path, or at the same path in the lowest open milestone once m1
  completes. It carries forward the last tag, its date, and anything to check
  first, and resets the `Waiting` item to two weeks after the new release.

## Waiting

- moq-dev/quest: two weeks pass since the last release (v0.2.1 once it
  ships); check `gh release list -R moq-dev/quest --limit 1`

## Required

- [Cut a release with the worktree hooks](/quest/m1/release.md) - v0.2.1 is
  the first release this cadence follows
