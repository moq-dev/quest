# [S] Harden the merge-queue runners

## Goal

The self-hosted `quest-queue`, `rind-queue` and `rust2-queue` runners that
the kixelated/nixos runner change adds run only
their own repository's merge-queue builds, and nothing else on the host
reaches them:

- kixelated/nixos's quest-land module creates no check launcher, users,
  networks, kvm access or storage tagging for a repository in watch mode.
- Each runner group admits only its repository's queue build.
- moq-dev/quest, moq-dev/rind and moq-dev/rust2 require approval before
  running workflows from any outside contributor's fork PR, not only a
  first-time contributor's.

## Plan

Decided 2026-11-02 (user, /quest-plan of the follow-ups from Claude's review
of the kixelated/nixos runner change in that day's `/quest-complete` session): ✅ all three
items, m0, ranked right after the [cutover](/quest/m0/queue-watcher/follow.md).

Decided 2026-11-03 (user, /quest-complete grill round), since GitHub matches a
runner group's selected workflow by its exact ref, with no wildcard, and a
merge group runs `queue.yml` from its own `gh-readonly-queue/main/pr-<n>-<sha>`
branch:

- How should each self-hosted runner group (quest-queue, rind-queue,
  rust2-queue) be restricted to its queue build?
  - ✅ (1) Reusable workflow (Recommended): move each repository's
    self-hosted job into a reusable workflow that `queue.yml` calls at `@main`
    and runs only for `merge_group`, then restrict the group to that workflow
    at `refs/heads/main`.
  - (2) Leave the groups unrestricted and rely on one-repository groups plus
    fork approval.

Done in [moq-dev/quest#439](https://github.com/moq-dev/quest/pull/439):

- Fork approval: on 2026-11-02 each repository's
  `fork-pr-contributor-approval` policy went from `first_time_contributors`
  to `all_external_contributors`.
- Watch-mode cleanup:
  a kixelated/nixos change, stacked on the runner change, generates check launchers, users, networks, staging, KVM grants and
  storage tagging only for repositories on `quest land serve`, and adds the
  `quest-land-watch` flake check.
- Reusable build, first step: each repository's self-hosted job moved into
  `.github/workflows/queue-build.yml`, which `queue.yml` calls by its local
  path. The build job and its caller both run only for `merge_group`, and a
  `Queue` job on a hosted runner reports the build's result under the context
  main's ruleset requires. This is moq-dev/quest#439 itself,
  [moq-dev/rind#289](https://github.com/moq-dev/rind/pull/289) and
  [moq-dev/rust2#536](https://github.com/moq-dev/rust2/pull/536).

Deployed 2026-11-04 (/quest-unblock): the watch-mode cleanup is live on the
land host (generation 80, deploy/quest-land b5d46f3); only
`quest-land-moq-pro-check.socket` remains and `/dev/kvm`'s ACL names no
check UID.

What remains:

- Once a repository's first step is on main, switch its `queue.yml` call to
  `moq-dev/<repo>/.github/workflows/queue-build.yml@main`. It can't be one
  step: a merge group calling `@main` before the file is there finds no
  workflow and fails. Say in that repository's contributing guide that a PR's
  edit to `queue-build.yml` runs only after it lands.
- Then restrict each group (see Waiting).
- Verify that a fork PR's workflow waits for approval.

## Waiting

- Maintainer: once a repository's `queue.yml` calls `queue-build.yml@main` on
  main, restrict its runner group to that workflow. Not before: the group
  would then admit no merge-group job and stall the queue. For moq-dev/quest
  (group 8; rind-queue is 9 and rust2-queue is 10, each with its own name and repository):
  `gh api -X PATCH orgs/moq-dev/actions/runner-groups/8 -f name=quest-queue -F restricted_to_workflows=true -f 'selected_workflows[]=moq-dev/quest/.github/workflows/queue-build.yml@refs/heads/main'`.
  Check that `gh api orgs/moq-dev/actions/runner-groups/8` shows
  `restricted_to_workflows: true` with that one workflow, and that the next
  merge group's `Queue build / Build` job still runs on the runner. GitHub
  documents workflow restriction for Enterprise Cloud while moq-dev is on the
  Team plan, though the API accepts the fields; if GitHub rejects or drops
  them, revert with `-F restricted_to_workflows=false` and fall back to option
  (2) above.
- Maintainer: the next time an outside contributor opens a fork PR on
  moq-dev/quest, moq-dev/rind or moq-dev/rust2, check that its workflow runs
  wait for approval.
