# [S] Harden the merge-queue runners

## Goal

The self-hosted `quest-queue`, `rind-queue` and `rust2-queue` runners that
[kixelated/nixos#19](https://github.com/kixelated/nixos/pull/19) adds run only
their own repository's merge-queue workflow, and nothing else on the host
reaches them:

- kixelated/nixos's quest-land module creates no check launcher, users,
  networks, kvm access or storage tagging for a repository in watch mode.
- Each runner group admits only its repository's
  `.github/workflows/queue.yml`.
- moq-dev/quest, moq-dev/rind and moq-dev/rust2 require approval before
  running workflows from any outside contributor's fork PR, not only a
  first-time contributor's (moq-dev/quest was `first_time_contributors` on
  2026-11-02).

## Plan

Decided 2026-11-02 (user, /quest-plan of the follow-ups from Claude's review
of kixelated/nixos#19 in that day's `/quest-complete` session): ✅ all three
items, m0, ranked right after the [cutover](/quest/m0/queue-watcher/follow.md).

- Watch-mode cleanup: the review found the base branch
  ([kixelated/nixos#16](https://github.com/kixelated/nixos/pull/16)) already
  creates check sockets and users for moq in watch mode, which only that
  repository's daemon user can reach. Gate them on `quest land serve` mode.
- Runner groups: #19 puts each runner in its own group, limited to its one
  repository. Limit each group to its repository's `queue.yml` too, through
  the org's runner group settings (`restricted_to_workflows`).
- Fork approval: a returning contributor's fork PR runs its own copy of the
  workflows, which can name a self-hosted label. Set each repository's
  `fork-pr-contributor-approval` policy to all outside contributors. Do this
  no later than the cutover registers the runners, if it's still open then.
- Verify by checking that a fork PR's workflow waits for approval, and by
  listing each group's allowed workflows.

## Related

- [Gate host](/quest/m0/host-land/host.md) - the host module these runners and daemons share
