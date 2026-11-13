# [M] Release every user-facing merge

## Goal

Each push to `main` with a user-facing change publishes a new quest release
with no person involved: the Release workflow picks the next version, tags
it, and publishes the binaries, so the biweekly cut and the maintainer's tag
push are gone. `quest --version` names the release in its binaries, and a
flake build names its release or commit.

## Plan

Decided 2026-11-13 (maintainer, /quest-plan; see the
[epic](/quest/m0/pin-bumps/README.md)): ✅ the workflow cuts every release
(rejected: each user-facing PR bumps `package.json` and a merge-time workflow
tags it, since PRs racing through the merge queue would conflict on that
line). This replaces the biweekly cut decided 2026-11-09 on
[moq-dev/quest#587](https://github.com/moq-dev/quest/pull/587) and lifts
CONTRIBUTING.md's rule reserving release tags for the maintainer: no release
has shipped since v0.1.0, because v0.2.0's run failed and v0.2.1 was never
tagged.

- Each run compares `main` with the last published release, not the push
  alone, and cuts when that range holds a user-facing change (anything beyond
  `quest/`, CI, tests, or chores). A tag whose run failed before publishing
  is built and published again before any newer one is cut, so a failed run's
  change ships with the next run instead of hiding behind its tag. Release's
  concurrency cancels superseded pull request runs today; runs on `main` must
  queue instead. The next version follows semver's 0.x convention from the
  range's conventional-commit subjects: minor when one carries `!`, patch
  otherwise.
- The version comes from the tag, not a commit: `package.json` stops carrying
  one, so no release needs a PR. Every reader of it takes the version from the
  build instead: `--version` in `src/cli/main.ts`, the stale-stub notice in
  `src/cli/hooks.ts`, `nix/package.nix`, and Release's version check and its
  Windows install check's fallback tag. A release binary embeds its
  tag; a flake build, which cannot see tags, embeds its commit. A tag pushed
  with `GITHUB_TOKEN` starts no other workflow, so the run that tags also
  builds and publishes.
- Update CONTRIBUTING.md's Releases section and SETUP.md's pinning advice.
- The first automated release only exists after the implementing PR merges.
  That PR rewrites this quest to its checks, with a `## Waiting` item on the
  release, rather than deleting it: the Windows ZIPs SETUP.md expects, every
  Install check job, and `quest worktree hook --help` from a release binary,
  which [the v0.2.1 cut](https://github.com/moq-dev/quest/blob/2a80c902/quest/m1/release.md)
  waited to check. Then drop SETUP.md's v0.1.0 caveat and the "next release"
  notes in README.md and docs/windows.md, and delete this quest.
- Milestone: ✅ m0 (rejected: m1), so those first-release checks, which the
  deleted m1 quests held, move to m0 with it.
