# [S] Harden the merge-queue runners

## Goal

The self-hosted `quest-queue`, `rind-queue` and `rust2-queue` runners that
[kixelated/nixos#19](https://github.com/kixelated/nixos/pull/19) adds run only
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
of kixelated/nixos#19 in that day's `/quest-complete` session): ✅ all three
items, m0, ranked right after the [cutover](/quest/m0/queue-watcher/follow.md).

Done in [moq-dev/quest#439](https://github.com/moq-dev/quest/pull/439):

- Fork approval: on 2026-11-02 each repository's
  `fork-pr-contributor-approval` policy went from `first_time_contributors`
  to `all_external_contributors`.
- Watch-mode cleanup:
  [kixelated/nixos#20](https://github.com/kixelated/nixos/pull/20), stacked on
  #19, generates check launchers, users, networks, staging, KVM grants and
  storage tagging only for repositories on `quest land serve`, and adds the
  `quest-land-watch` flake check. It removes moq's, quest's, rind's and
  rust2's check resources from the host once deployed.

What remains:

- Runner groups: limiting each group to `queue.yml` through
  `restricted_to_workflows` can't work as decided. GitHub matches a selected
  workflow by its exact ref and accepts no wildcard, and a merge group runs
  `queue.yml` from its own `gh-readonly-queue/main/pr-<n>-<sha>` branch, so
  an entry pinned to `refs/heads/main` would leave every merge-group job
  waiting for a runner. See the Waiting decision.
- Deploy kixelated/nixos#20 with the rest of the stack.
- Verify by checking that a fork PR's workflow waits for approval, and by
  listing each group's allowed workflows if the restriction goes ahead.

## Waiting

- Maintainer: decide how to restrict each runner group to its queue build.
  (1) Move each repository's self-hosted job into a reusable workflow that
  `queue.yml` calls at `@main`, runs only for `merge_group`, and restrict the
  group to that reusable workflow at `refs/heads/main`. Then even an approved
  fork run can't reach the runner, but a PR's own edit to that job is tested
  only after it lands. (2) Leave the groups unrestricted and rely on the
  one-repository groups plus fork approval for every outside contributor.
  Recommended: (1), since fork approval is a click a maintainer can give by
  mistake, while (1) holds for every run. Check it with
  `gh api orgs/moq-dev/actions/runner-groups/<id>` showing
  `restricted_to_workflows: true` and a merge group still running on the
  runner.
- Maintainer: deploy [kixelated/nixos#20](https://github.com/kixelated/nixos/pull/20)
  through `deploy/quest-land`, since only the maintainer activates the live
  host. Check that `systemctl list-units 'quest-land*check*'` shows only
  `quest-land-moq-pro-check.socket`, and that `getfacl /dev/kvm` names no
  check UID.

## Related

- [Gate host](/quest/m0/host-land/host.md) - the host module these runners and daemons share
