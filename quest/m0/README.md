# moq-dev adoption

## Goal

moq-dev plans and runs its own work through Quest and kix:
moq-dev/moq, moq-dev/quest, and moq-dev/moq.pro are enrolled at
`https://quest.moq.dev`, maintainers answer decisions from a phone-friendly
web app with push notifications, and their own Linux and macOS runners do
the work through Claude Code and opencode inside each project's Nix
devShell. The GitHub App bot publishes ordinary PRs. The standalone CLI
(v0.1.0 shipped on 2026-10-07) keeps serving the same repositories locally on
macOS, Linux, and native Windows.

Work that only third-party repositories need, and the public launch, belong
to [m1](/quest/m1/README.md).

## Plan

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

Decided while planning m0 (2026-09-26), replacing the earlier copied-files and
ownership-manifest design:

- The binary carries the skills, the quest contract, and all hook logic.
  `quest init` installs only static stubs into a repository: one-line skill
  stubs, one reference line in its root instructions, one `.gitattributes`
  line, and Claude hook entries in `.claude/settings.json` that only call a
  `quest` subcommand. Upgrading never rewrites repository files. (Amended
  2026-10-26 (user), replacing "Nothing is vendored", so `quest init` can
  install the agent lifecycle hooks. Amended 2026-11-01 (user, /quest-plan):
  `quest init` also rewrites a Quest-written stub nobody edited when its
  text is out of date; see [Skill stub cleanup](/quest/m0/skill-stubs.md).)
- The repository's own tool manager pins the version: mise (release binaries)
  or a nix flake input (any rev, built from source). Quest ships no launcher
  and no pin file; an install outside either is simply unpinned.
- The CLI may call GitHub (amended 2026-10-07, replacing "offline except
  `quest run`" after agents' hand-rolled polling tripped GitHub's rate
  limits). Prefer offline, deterministic commands, and keep GitHub calls in
  the CLI rather than skill prose.
- Repository-specific rules stay in the repository's own root instructions.

## Required

- [Merge through a host gate](/quest/m0/host-land/README.md) - inline merge picks, small batches landed from the maintainer's host, and a Codex fixer instead of bisection
- [The land fixer handles every mechanical failure](/quest/m0/land-fixer/README.md) - attempts, registry network, triage, flaky tests, local mergeability, protected edits, and fork commits
- [Landing priority](/quest/m0/land-priority.md) - cheap checks wait a bounded time and the land daemon's check runs ahead of agent builds
- [Drop emptied Required headings](/quest/m0/required-heading.md) - a clean driver merge that empties a `Required` list passes `quest check`
- [Current conflict reports](/quest/m0/land-conflicts-refresh.md) - a queued PR's conflict report updates when the queue ahead of it changes
- [Land checks at gate priority](/quest/m0/land-priority-sandbox.md) - `quest land serve` passes `QUEST_GATE_PRIORITY` to its sandbox
- [Squash mismatch comment](/quest/m0/land-squash-mismatch.md) - a post-squash `tree_mismatch` posts a CRITICAL comment on the merged PR
- [Current landing status](/quest/m0/status-landing.md) - `quest status` drops a stale `landing-stopped` line and ignores superseded cancelled checks
- [Kix decision UI](/quest/m0/kix/README.md) - planning and implementation through prompts and summaries, run on the maintainer's own runners
- [Codex cloud off](/quest/m0/codex-cloud-off.md) - automatic Codex cloud reviews stop once no open PR relies on them
- [Agent test environment](/quest/m0/agent-test-env.md) - `just test` passes inside agent sessions
- [Stale skill stubs](/quest/m0/init-prune.md) - `quest init` and `quest uninstall` remove stubs of retired skills such as `quest-ready`
- [Bun EFAULT report](/quest/m0/bun-efault.md) - condition: Bun fixes concurrent `rmSync` on Windows; report it, then drop the workaround
- [Codex project-config skip](/quest/m0/codex-project-config.md) - condition: Codex keeps a supported way to skip a project's `.codex/` layer; then reviews keep the user's config
- [Gate bench](/quest/m0/gate-bench.md) - measure headroom admission on an idle host
- [Gate admission on CI](/quest/m0/gate-ci-admission.md) - gated commands admit on loaded hosted runners like arm64 macOS
- [Agent workflow helpers](/quest/m0/helpers/README.md) - CLI commands for CI waits, PR status, claims, quest moves, and serialized merges
- [Review the branch's own change](/quest/m0/review-merge-base.md) - `quest review` diffs against the merge base and accepts a detached `HEAD`
- [Skill stub cleanup](/quest/m0/skill-stubs.md) - stray skill copies deleted, and `quest init` refreshes unedited outdated stubs
- [Merge driver upkeep](/quest/m0/merge-driver-upkeep.md) - local merges drop links to finished quests, old drivers upgrade, and `quest-pinned` stays current
- [Worktree hooks here](/quest/m0/worktree-hooks.md) - `quest` reaches Claude Code's hooks and the merge driver in this repository, then `quest init` installs the hooks
- [Other worktree routes](/quest/m0/worktree-routes.md) - live-check PR worktrees, agent view, remote-control, and workflow agents against the hooks
- [Spotlight off in macOS CI](/quest/m0/ci-spotlight.md) - this repository's macOS jobs turn off Spotlight indexing first
- [Review through a gateway](/quest/m0/review-gateway.md) - `quest review` keeps gateway, cloud-provider, and Codex connection variables
- [opencode SDK 2.x](/quest/m0/opencode-sdk.md) - the runner moves to `@opencode/sdk` 2.x so the nixpkgs bump lands
- [Review harness check](/quest/m0/review-harness.md) - recurring each milestone: newest pinned review models, and the live sandbox test passes
