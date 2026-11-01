# [M] Approve a PR head for host runners

## Goal

A maintainer can approve one exact PR head in kix, so its iterate and merge
jobs run on any runner even though not every commit carries a maintainer
signature. The common case is a head kix itself pushed. The approval covers
only that SHA. It lapses when the head moves, and kix rechecks the approver's
current maintain or admin role each time it relies on the approval.

## Plan

Decided 2026-10-28 (user, /quest-plan trust audit, from Codex Security's P1 on
[moq-dev/quest#243](https://github.com/moq-dev/quest/pull/243)):

- **Publication is not trust.** kix publishes whatever the runner sends. A
  prompt-injected agent or a compromised runner could therefore publish a
  `flake.nix` that host Nix evaluates outside the sandbox. So "kix pushed it"
  never grants host trust. [moq-dev/quest#243](https://github.com/moq-dev/quest/pull/243)
  trusts only commits signed by current maintainers and drops the publication
  ledger.
- This quest adds the explicit path. Show the approval as a decision item
  linking GitHub's compare view of the commits beyond the default branch.
  Record the approver, the SHA, and the time. Recheck the approval at job
  creation and at assignment, as trust classification does.
- GitHub's PR approvals can't serve: the maintainer usually authors these
  PRs, and can't approve their own.
- Test approval of a kix-pushed head, a head that moves after approval, an
  approver who loses the role, and an approval from someone who isn't a
  maintainer.
