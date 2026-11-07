# [S] The sandbox boundary tests run on PRs that move the agents

## Goal

A PR that changes what the runner's agents are, such as a `flake.lock`
bump or a change to the opencode client or the runner's sandbox code, runs
the live boundary tests (`just runner-sandbox`) before it lands, so a
failure shows on the PR instead of the next nightly run. The merge gate
still does not wait on them.

## Plan

Decided 2026-11-07 (coordinator, follow-up of
[moq-dev/quest#536](https://github.com/moq-dev/quest/pull/536)): the
nixpkgs bump in [moq-dev/quest#502](https://github.com/moq-dev/quest/pull/502)
moved the pinned opencode from 2.1.1 to 2.2.1, which offered jobs its own
session and worktree tools outside the sandbox. Nothing ran the boundary
test until the next nightly run, which failed after the bump had merged.

- Add a `pull_request` trigger with a paths filter to
  `.github/workflows/sandbox.yml`: `flake.lock`, `flake.nix`, the runner's
  sources and its live tests. Keep the job off the merge queue's required
  checks; `/quest-merge` already names a failing optional check before it
  queues.
- Keep the workflow read-only (`contents: read`, no secrets), since it runs
  PR code.
- Update the workflow's header comment and the sandbox epic's README,
  which say the test runs only nightly.
