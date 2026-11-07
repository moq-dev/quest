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
  [token waste](/quest/m0/token-waste/README.md) audit): an epic's children
  are its directory, so list order no longer ranks work within m0;
  `quest unblocked` ranks by milestone, then downstream impact, then path.
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

## Required

- [Land through a serial merge queue with an async fixer](/quest/m0/queue-watcher/README.md) - GitHub's merge queue, or the watcher's own where GitHub has none, lands one PR at a time, and a host watcher fixes and re-enqueues each PR it drops
- [Review sessions keyed by upstream branch](/quest/m0/review-session-key.md) - a round from a local branch tracking the PR branch continues that branch's review session
- [Kix decision UI](/quest/m0/kix/README.md) - planning and implementation through prompts and summaries, run on the maintainer's own runners
- [Route quests to models by size](/quest/m0/model-routing/README.md) - `/quest-spawn` starts each quest on the first model of its size's ranked list that can run, reviews rank the same way, and PRs record size, implementer, and reviewer
- [Repositories and hosts follow quest's main](/quest/m0/pin-sync.md) - every push to main reaches each enrolled repository and host through a bot-queued pin bump
- [Cut agent token waste](/quest/m0/token-waste/README.md) - sessions stop paying for loading rules, a second review pass, polling, oversized coordinators, and merge churn
- [quest check rejects a misleveled Waiting heading](/quest/m0/waiting-heading-level.md) - a `### Waiting` (or any non-`##` level) fails `quest check` with its file and line, so no wait drops out of `quest waiting`
- [Model check](/quest/m0/model-check.md) - recurring: the first audit of the routed PRs retunes the built-in size lists
- [Codex cloud off](/quest/m0/codex-cloud-off.md) - automatic Codex cloud reviews stop once no open PR relies on them
- [Codex project-config skip](/quest/m0/codex-project-config.md) - once Codex keeps a supported way to skip a project's `.codex/` layer, reviews keep the user's config
- [Agents get the dev shell from user settings](/quest/m0/user-dev-shell/README.md) - maintainers' own Claude and Codex settings load the dev shell; repositories drop dev-shell hooks, Quest worktree hooks, and `nix develop` instructions, and `quest init` writes no hooks
- [Session checkouts released](/quest/m0/session-checkouts.md) - a Claude session's own checkout is released when the session ends and reclaimed on resume
- [claude rm upstream report](/quest/m0/claude-rm-upstream.md) - posting approved: ask Claude Code to run `WorktreeRemove` instead of advising an unlock
- [Three generic rules in the shared context](/quest/m0/context-rules.md) - `quest context` adds matching conventions, never loosening a flaky test, and short names under a namespace
