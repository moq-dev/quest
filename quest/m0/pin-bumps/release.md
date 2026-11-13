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

- A push with no user-facing change (only `quest/`, CI, tests, or chores)
  cuts nothing. The next version follows semver's 0.x convention from the
  conventional-commit subjects since the last tag: minor when one carries `!`,
  patch otherwise.
- The version comes from the tag, not a commit: `package.json` stops carrying
  one, so no release needs a PR. A tag pushed with `GITHUB_TOKEN` starts no
  other workflow, so the run that tags also builds and publishes.
- The first release checks what [the release cut](https://github.com/moq-dev/quest/blob/2a80c902/quest/m1/release.md)
  waited to check: the Windows ZIPs SETUP.md expects and every Install check
  job. Then drop SETUP.md's v0.1.0 caveat and the "next release" notes in
  README.md and docs/windows.md.
- Update CONTRIBUTING.md's Releases section and SETUP.md's pinning advice.
