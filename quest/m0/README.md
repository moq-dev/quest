# moq-dev adoption

## Goal

moq-dev plans and runs its own work through Quest and kix:
moq-dev/moq, moq-dev/quest, and moq-dev/moq.pro are enrolled at
`https://quest.moq.dev`, maintainers answer decisions from a phone-friendly
web app with push notifications, and their own Linux and macOS runners do
the work through Claude Code and opencode inside each project's Nix
devShell. The GitHub App bot publishes ordinary PRs. The standalone CLI
(v0.1.0 shipped on 2026-10-07) keeps serving the same repositories locally on
macOS and Linux.

Work that only third-party repositories need, native Windows, and the public
launch belong to [m1](/quest/m1/README.md).

## Plan

Decided 2026-11-03 (user, /quest-complete, on
[moq-dev/quest#455](https://github.com/moq-dev/quest/pull/455)), after the
native Windows suite moved to m1 with nightly-only coverage:

- Should m0's Goal drop native Windows?
  - ✅ Narrow m0's Goal (recommended)
  - Leave it

Decided 2026-10-30 (user, /quest-plan), replacing "First public release":

- Should m0 serve moq-dev's repositories before third parties?
  - ✅ Yes: m0 is adoption on moq-dev/moq, moq-dev/quest, and moq-dev/moq.pro;
    a new m1 holds the public release, and the old m1 became m2
  - Fold third-party work into the existing later milestone

  No resources go into a public service before it works for moq-dev.
- Where does the Worker live until the public launch?
  - ✅ quest.moq.dev
  - kix.moq.dev

  [Open kix.quest](/quest/m1/open.md) moves it for the launch.
- Which kix work leaves m0? ✅ Onboarding (pick repositories, setup PR,
  guide), ✅ the public face (theme, landing page, launch material), ✅
  contributor sandboxing (untrusted-head VM, stock-Ubuntu AppArmor, macOS
  verification), and ✅ the enrollment-time read-only CI check. Head approval
  and opencode sandboxing stay, since moq-dev's own jobs need them.
- moq-dev/moq comes first, then private repositories so moq.pro can enroll.
- Where does Kix rank in m0? Decided 2026-11-01 (user, /quest-complete):
  - ✅ Land work first (the host gate, the land fixer and the land quests),
    then Kix, then the rest of m0
  - Kix first
  - Kix below the review quests

  The land work is what moq-dev's repositories use every day, and the
  maintainer ranked it first in the 2026-10-30 and 2026-11-01 sessions.
  Superseded 2026-11-05 (user, /quest-plan, the
  [token waste](/quest/m0/token-waste/README.md) audit): epics no longer
  list their children, so no list ranks work within m0; `quest unblocked`
  ranks by milestone, then downstream impact, then path.
- How do moq-dev's repositories land? Decided 2026-11-01 (maintainer,
  /quest-plan), reversing the 2026-10-26 move to a batched gate:
  - ✅ Through GitHub's merge queue again, one PR at a time, with no batching
    and no pre-checks. A host watcher runs the Codex land fixer on each PR the
    queue drops and re-enqueues it, so only decisions reach a person. The
    batched gate was left for GitHub's inability to resolve quest-file
    conflicts (71% of moq's 246 removals); the async fixer now absorbs those.
  - Keep the host queue, serial

  The [queue watcher](/quest/m0/queue-watcher/README.md) ranks first and
  records the full interview: moq first, self-hosted `merge_group` runners,
  host-gate work frozen, build concurrency 1, re-enqueue at the back,
  unlimited attempts while progressing, flaky re-enqueues, and fixing picks
  GitHub refuses. The land work above now means the watcher first, then the
  fixer and its host.

Decided while planning m0 (2026-09-26), replacing the earlier copied-files and
ownership-manifest design:

- The binary carries the skills, the quest contract, and all hook logic.
  `quest init` installs only static stubs into a repository: one-line skill
  stubs, one reference line in its root instructions, and one
  `.gitattributes` line. Upgrading never rewrites repository files. (Amended
  2026-11-01 (user, /quest-plan): `quest init` also rewrites a Quest-written
  stub nobody edited when its text is out of date. Amended 2026-11-03
  (maintainer, /quest-unblock): `quest init` writes no Claude hook entries;
  Quest's worktree hooks are a user-level opt-in, see
  [user-dev-shell](/quest/m0/user-dev-shell/README.md).)
- The repository's own tool manager pins the version: mise (release binaries)
  or a nix flake input (any rev, built from source). Quest ships no launcher
  and no pin file; an install outside either is simply unpinned.
- The CLI may call GitHub (amended 2026-10-07, replacing "offline except
  `quest run`" after agents' hand-rolled polling tripped GitHub's rate
  limits). Prefer offline, deterministic commands, and keep GitHub calls in
  the CLI rather than skill prose.
- Repository-specific rules stay in the repository's own root instructions.
