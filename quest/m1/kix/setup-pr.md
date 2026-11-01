# [M] Open a Quest setup PR when enrolling

## Goal

A maintainer enrolls a repository that has no Quest files, and the App opens
a pull request with what `quest init` writes, with no runner involved. The
project waits in a setting-up state that links the pull request and is
enabled when it merges.

## Plan

Decided 2026-10-27 (user), option A of the onboarding round that also
adopted GitHub App sign-in, chosen over running setup as a runner job, which
needs a runner before a project can enroll:

- A repository without Quest gets the bot's setup PR. What state is it in
  until that PR merges?
  - ✅ Enrolled, setting up
  - Not enrolled yet

  The merge webhook enables the project with no second visit. A closed pull
  request leaves the project in setting up, offering a retry or disconnect.
- Move `init`'s file plan into the core so it returns the files to write
  instead of writing them, and have both the CLI and the Worker use it: the
  skill stubs, `quest/README.md`, the `Quests: ` line, `.gitattributes`, and
  the Claude hook entries in `.claude/settings.json`. The Worker publishes them
  through the same path as job branches, on a branch outside `quest/`.
- The enrollment form asks, optionally, what the project is working toward,
  and writes the answer as `quest/README.md`'s Goal.
- An init refusal names the conflicting path on the setup page, as the CLI
  does; kix never deletes or renames a repository's files.
- The pull request body says what the PR leaves out, since those steps need
  an agent's judgement: pinning `quest` in the repository's tool manager and
  adapting existing instructions. kix jobs do not need either, because runners
  bring their own `quest`. A missing `flake.nix` still leads to the existing
  `bootstrap` job.

## Required

- [Upstream branches](/quest/m0/kix/upstream-branches.md) - the App publishes on the upstream, where this pull request's branch lives
