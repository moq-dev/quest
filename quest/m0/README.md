# moq-dev adoption

## Goal

moq-dev plans and runs its own work through Quest: moq-dev/moq,
moq-dev/quest, and moq-dev/moq.pro plan in quests, maintainers' own agent
sessions implement them through the skills, and PRs land through GitHub's
merge queue, with the host's watcher fixing what it drops. moq-bot is the one
GitHub App the host's daemons act as. The standalone CLI (v0.1.0 shipped on
2026-10-07) serves the same repositories locally on macOS and Linux.

Work that only third-party repositories need, native Windows, and the public
launch belong to [m1](/quest/m1/README.md).

## Plan

Decided 2026-11-08 (user): Quest serves moq-dev only, so kix goes. Its
Worker at quest.moq.dev, `quest runner`, the `quest:kix` hold, kix's
sessions comment, and its GitHub App, kixel-quest, are deleted, along with
the quests that built on them. moq-bot is the only GitHub App.

- Does kix go, or only its App?
  - ✅ Delete kix entirely (recommended): it had never run on a real
    repository, since kixel-quest was installed nowhere
  - Keep kix, run as moq-bot: the Worker would hold a key with moq-bot's
    workflow and runner access
  - Keep kix, move it to the host

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
- Where the Worker lived, which kix work left m0, and where kix ranked
  were decided 2026-10-30 and 2026-11-01; kix's deletion on 2026-11-08
  supersedes them. Ranking was already superseded 2026-11-05 (user, /quest-plan, the
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
