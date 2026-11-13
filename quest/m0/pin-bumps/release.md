# [M] Release every merge that changes what ships

## Goal

Each push to `main` that changes what ships publishes a new quest release
with no person involved: the Release workflow picks the next version, tags
it, and publishes the binaries, so the biweekly cut and the maintainer's tag
push are gone. `quest --version` names the release in its binaries, and a
flake build names its release or commit.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan; see the
[epic](/quest/m0/pin-bumps/README.md)): ✅ the workflow cuts every release
(rejected: each user-facing PR bumps `package.json` and a merge-time workflow
tags it, since PRs racing through the merge queue would conflict on that
line). This replaces the biweekly cut decided 2026-11-09 on
[moq-dev/quest#587](https://github.com/moq-dev/quest/pull/587) and lifts
CONTRIBUTING.md's rule reserving release tags for the maintainer: no release
has shipped since v0.1.0, because v0.2.0's run failed and v0.2.1 was never
tagged.

Decided 2026-11-12 (maintainer, at the review's design checkpoint): ✅ Release
reconciles `main` with the published releases, and tagging is its last step
(rejected: recovery steps for each way a run can fail, which review kept
finding new cases of; semantic-release, an added dependency that publishes
before the checks this needs to pass first). So:

- Every run, on each push to `main` and on a daily schedule, compares `main`
  with the latest published release and cuts one when that range touches
  what ships: the paths Release's pull request filter already lists as
  building the binaries, plus every file it publishes, such as
  `scripts/installer.sh`. One predicate serves both, so they cannot drift. A
  cancelled or failed run then needs no recovery: the next run sees the same
  unreleased range. Runs on `main` queue rather than cancel each other.
- A run builds every binary and passes the lifecycle and archive install
  checks on those local artifacts before it tags. It then uploads every
  asset to a draft release and publishes the draft, which creates the tag, so
  no tag exists without its complete release; a run that fails before that
  leaves only a draft, which the next run replaces. The next version is
  greater than every existing tag, so the dead v0.2.0 tag is skipped (v0.2.1
  was never tagged): minor when the range holds a `!` subject, patch
  otherwise.
- The checks that need a published release, mise and the installer's URL,
  run after it and fail loudly; their fix ships as the next release. They
  block no consumer, since the bump pass moves flake pins, which build from
  source at the release's commit.
- The version comes from the tag: `package.json` stops carrying one, so no
  release needs a PR. Everything that reads it moves to the build's input:
  find them by searching for it, since they span the CLI (`src/cli/main.ts`,
  `src/cli/hooks.ts`), `nix/package.nix`, `scripts/lifecycle-check.mjs`, the
  tests, and the workflows' version checks and Windows fallback tag. A
  release binary embeds its tag; a flake build, which cannot see tags, embeds
  its commit.
- Update CONTRIBUTING.md's Releases section and SETUP.md's pinning advice.
- The first automated release exists only after the implementing PR merges.
  That PR rewrites this quest to its checks, with a `## Waiting` item on the
  release, rather than deleting it: the Windows ZIPs SETUP.md expects, every
  Install check job, and that a release binary has `quest worktree hook`, the
  Goal of [the v0.2.1 cut](https://github.com/moq-dev/quest/blob/2a80c902/quest/m1/release.md). Then drop SETUP.md's v0.1.0 caveat and the "next release"
  notes in README.md and docs/windows.md, and delete this quest.
- Milestone: ✅ m0 (rejected: m1), so those first-release checks, which the
  deleted m1 quests held, move to m0 with it.
