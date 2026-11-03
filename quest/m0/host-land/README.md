# Merge through a host gate until the merge queue replaces it

## Goal

The maintainer's host runs the land fixer in ephemeral nspawn containers for
the [queue watcher](/quest/m0/queue-watcher/README.md), and keeps landing the
repositories not yet on GitHub's merge queue (moq-dev/quest, moq.pro, rust2
and rind) through the host gate until they
[follow](/quest/m0/queue-watcher/follow.md). The gate is frozen: it gets only
fixes the switch needs, and is
[retired](/quest/m0/queue-watcher/retire.md) once nothing lands through it.

`/quest-merge` queues a pick inline only when a counted review names its head,
or the head is trivial; otherwise `/quest-iterate` runs first. That part of
the 2026-10-30 design stands.

Non-goals: changing the review policy beyond the mechanical-fix exemption.

## Plan

Decided 2026-10-30 (user, /quest-plan). Per-PR `/quest-merge` sub-agents were
wasteful: each one stayed alive to fix conflicts and failures that the gate
can hand off instead.

- Goal, as stated above:
  - ✅ Yes, as stated
  - Also include moq adoption
  - Narrower: only the skill changes
- Where the gate runs. Keeping it in GitHub Actions was recommended, since it
  is live and isolates the push credential; the user chose the host.
  - Keep GitHub Actions
  - ✅ Move to this host
- Architecture, once on the host:
  - Host orchestrates, CI on Actions
  - ✅ Everything on this host: the worker runs the check locally through
    `quest gate`, pushes, and starts Codex. No Actions involved in landing.
  - Everything stays in Actions
- Queue signal. The user asked for a check nobody reports, so PRs stay in
  auto-merge until the host reaches them; `main`'s ruleset already requires
  the unreported `quest land` check. GitHub keeps auto-merge across a
  writer's push, so the gate compares the head to the pin and ejects
  `head_moved`.
  - ✅ Pinned auto-merge (`quest merge --land`) plus `quest:merge`; the label
    was deleted on 2026-10-31 (user), leaving pinned auto-merge alone
  - Label only, with the label's time against the last push
- Retry cap for the fixer:
  - 2 attempts
  - ✅ 1 attempt
  - The review-round checkpoint
- Push credential:
  - Your gh auth through the admin bypass, check sandboxed
  - ✅ A moq-bot App key on this host, check sandboxed
  - Your gh auth, no sandbox
- Runtime. A one-pass systemd timer was recommended:
  - systemd timer, one pass per run
  - ✅ A long-running daemon
- Review of the fixer's changes:
  - Claude reviews them through `quest review`
  - ✅ None: Codex makes only mechanical fixes; anything that would need a
    review is ejected and handed back
- Mechanical fixes:
  - ✅ No behavior change, recorded in `## Review`
  - Tool-verifiable only
- Batch:
  - ✅ The longest-queued PR as the base, plus the next PRs in queue order
    that merge cleanly onto the chain, up to floor(log₂ n)
  - Quest priority order
- Open PRs: land
  [moq-dev/quest#289](https://github.com/moq-dev/quest/pull/289) now, as it
  fixes live wrong ejections until the host gate replaces that code; close
  [moq-dev/quest#277](https://github.com/moq-dev/quest/pull/277), since an
  ejection now disables auto-merge and the fixer re-enables it.
- Security (user, 2026-10-30): the gate runs as a dedicated user under a
  hardened unit. PR code and Codex run in ephemeral nspawn containers with no
  credentials. moq-bot tokens are minted per push and scoped to this
  repository. Codex reaches its model through the host's CLIProxyAPI, so the
  Codex login stays outside the container. A maintainer's approval of the
  pinned head covers evaluating its devShell, but the fixer may not touch
  files that run outside the sandbox.
- No GitHub Actions in landing (user, 2026-10-30): the daemon replaces the
  Land workflow and the host's `quest-land` Actions runner, and ejection
  comments carry the failing log's tail.
- This epic ranks first in m0. It replaces the hook-started kix fixer
  (`kix/eject-fix`) that
  [moq-dev/quest#276](https://github.com/moq-dev/quest/pull/276) proposed;
  #276 was closed as superseded on 2026-11-01.
- The epic finishes with an end-to-end run on moq-dev/quest: a batch with one
  PR that fails a check, one that conflicts with the base, and one healthy
  PR. The healthy PR lands after the requeue, the mechanical one lands after
  its fix, and the other is handed back. `CONTRIBUTING.md` and the README's
  landing section describe the host gate.
- Amended 2026-10-31 (user): the fixer triages a failing batch before
  anything is ejected, and only the PR it blames is ejected. Batch triage
  ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)) went further: nothing is ejected for a failure, and the
  blamed PR is parked for the fixer.

- Superseded 2026-11-01 (maintainer, /quest-plan; see the
  [queue watcher](/quest/m0/queue-watcher/README.md)): each repository lands
  through GitHub's merge queue again, one PR at a time, and a host watcher
  runs this epic's fixer on each PR the queue drops and re-enqueues it.
  moq-dev/moq moves first. The batched gate described above keeps serving the
  other repositories until they follow, with its work frozen except for fixes
  the switch needs. Its end-to-end batch run and its docs are dropped; the
  watcher epic has its own. Deleted with it: keeping an in-flight batch check
  across daemon restarts, current queue-conflict reports, the post-squash
  mismatch comment, and gate priority for batch checks, all host-gate
  improvements the freeze stops.

## Required

- [Gate host](/quest/m0/host-land/host.md) - kixelated/nixos runs the daemon as its own user, checks in nspawn containers, and retires the Actions runner
- [Fixer proxy access](/quest/m0/host-land/fixer.md) - connect the nixos fixer container to CLIProxyAPI with the gate client key and maintainer login
- [Fixer TLS](/quest/m0/host-land/fixer-tls.md) - the fixer's container trusts public certificates, so workerd and the Worker tests run there
