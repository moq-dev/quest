# [S] The watcher runs one instance per base branch

## Goal

`quest land watch` can run one instance per base branch of a repository, each
with its own clone, locks, state and `--method`, so moq.pro's `release` can
land through its own watcher beside `main`'s.

Two instances on different bases of one repository start and run side by
side, whether from one checkout and user or from two host units, while two
daemons on the same base, `quest land serve` included, still refuse to run
beside each other: from one checkout or state directory by their locks, and
as two host units by the host module refusing the configuration. Neither
instance reads, enqueues, fixes, prunes, or posts about the other's PRs.
`quest land watch --help`, the README's landing section and `CONTRIBUTING.md`
say one daemon per base rather than per repository.

Non-goals: declaring moq.pro's second instance on the host and moving its
`release` onto it, which moq.pro's own Land release quest does once
[its `main` cutover](/quest/m0/queue-watcher/pro-cutover.md) works, and
showing each base's queue on kix.quest, which
[the queue page](/quest/m0/queue-watcher/queue-page.md) owns.

## Plan

Decided 2026-11-07 (maintainer, /quest-plan), as a follow-up from planning
moq.pro's release landing. Decision prompts, selected options marked ✅:

- Goal:
  - ✅ Plan it, with the goal as stated
  - Fold it into the own queue (the README's "The watcher's own queue")
  - Drop it
- Milestone:
  - ✅ m0, inside this epic
  - m1

What one repository's daemons share today, at `1c3cf6a`:

- Clone and locks: `startDaemon` (`src/cli/land-serve.ts`) holds
  `quest-land.lock` in the git common directory of the checkout the daemon
  runs from, keyed by nothing but that checkout, and a `lock` file in the state
  directory. That is how `quest land serve` and `quest land watch` exclude each
  other, and it also refuses a second watcher on another base from the same
  checkout.
- State: the default state directory, `defaultState`, is
  `<$STATE_DIRECTORY or $XDG_STATE_HOME/quest-land>/<owner>-<repo>`, keyed by
  repository only. It holds the private `repository.git` the fixer works in,
  `watch.json` (the removals handled and the pass's `since`), the
  `watch-job-*.json` fixer jobs, each pick's rounds, and the logs.
- Base: `--base` exists, but without it each pass re-reads the default branch,
  so the base is known only after the locks are taken.
- Already per base: the open-PR query filters on `baseRefName`, so removals,
  enqueues and fixes only touch the base's PRs; the own queue names its branches
  `quest-queue/<base>/<number>`; flaky-disable branches are keyed by commit.

What per-base separation needs:

- Resolve the base once at startup, from `--base` or the default branch, before
  taking any lock, and keep it for the daemon's life: a renamed default branch
  then needs a restart.
- Key both locks and the default state directory by repository and base: the
  checkout's lock becomes one file per base, such as
  `quest-land-<base>.lock` with `/` in a base name escaped, and the default
  state directory gains the base, such as `<owner>-<repo>@<base>`, with a
  separator no repository name contains so no two pairs share a directory.
  `AGENTS.md` skips migrations of on-disk state, so the default branch's
  directory moves too and each deployed watcher restarts with fresh progress
  (`since` falls back to its start less `SETTLE`, and `handled` is empty):
  deploy it while no fixer job runs and no PR left the queue in the last
  `SETTLE`, so no job is orphaned and no removal is handled twice. Since
  `serve` and `watch` keep sharing `startDaemon`, a gate and a watcher on one
  base still share a state directory and exclude each other, which
  [moq.pro's cutover](/quest/m0/queue-watcher/pro-cutover.md) and
  [the retire quest](/quest/m0/queue-watcher/retire.md)'s log pruning rely on.
- Each instance keeps its own private repository, so a second base costs a
  second clone's disk rather than a shared object store with its own locking.
- `--method` comes from the own queue (the README's "The watcher's own queue")
  and is already per process; check that nothing the method affects, such as
  the landed-tree verification or a fixer's base merge, reads state outside
  the instance's directory.
- The own queue's start-up pruning of stale queue branches must list only
  `quest-queue/<base>/`, never another instance's branches.
- Test two `startDaemon` calls from one checkout: different bases both start,
  and the same base refuses the second, for `serve` and `watch` alike.

How the host would declare a second instance: the host module (kixelated/nixos
`modules/quest-land.nix`) already makes one unit per
`services.quest-land.repositories` entry, each with its own system user,
`StateDirectory`, and `$STATE_DIRECTORY/checkout`, so two entries naming the
same `repository` already get separate clones, locks and state. The module
needs a `base` option (null for the default branch) and a `method` option,
passed as `--base` and `--method` to `quest land watch`, and an assertion
that no two entries share a `repository` and `base`, since two units never
share a checkout or state directory and so never see each other's locks,
and moq.pro adds an entry such as `moq-pro-release` with `repository = "moq-dev/moq.pro"`,
`watch = true`, `base = "release"` and `method = "merge"`. Each entry still
takes a unique `id`. Both instances share the host's three fixer slots, so
each keeps the default `--fixer-jobs`; `release` lands rarely. That host PR
belongs to moq.pro's Land release quest, which consumes this one.

