# [S] moq.pro lands main through the watcher's own queue

## Goal

moq-dev/moq.pro's `main` lands through the watcher's own queue (the README's
"The watcher's own queue") instead of the batching `quest land serve` gate:

- moq.pro's queue workflow builds the watcher's queue branches on its private
  `moq-pro-gate` runner;
- the host's moq.pro land instance in kixelated/nixos runs
  `quest land watch` instead of `quest land serve`;
- moq.pro's picks queued on the gate carry over;
- a PR lands through the own queue, and a PR dropped for a failing build is
  fixed and re-enqueued.

moq.pro's `main` ruleset keeps requiring the unreported `quest land` check
with moq-bot as a bypass actor, since the own queue relies on GitHub never
merging a pick itself.

Non-goals: moq.pro's `release` branch, which moq.pro's own Land release
quest moves onto a second watcher instance on that base once `main`
works, and the Nix
store isolation that moq.pro's CI host quest requires from public moq jobs,
which that quest owns and this cutover leaves no worse.

## Plan

Decided 2026-11-06 (maintainer, /quest-plan): moq.pro moves `main` first and
`release` after, rather than both at once, so a first-cutover problem stays on
one branch. moq.pro is private on GitHub Team, where GitHub offers no merge
queue, so it is the repository the own queue exists for.

- Follow the public repositories' cutover (2026-11-03, described in
  moq-dev/quest's `queue.yml` header and the README): a
  moq.pro PR adds the queue workflow and its queue-branch trigger, a
  kixelated/nixos PR switches the daemon, and the first queue builds may show
  gaps in the runner's environment, which are fixed in that PR or in moq.pro.
- moq.pro's `queue.yml` is still its label queue's control workflow, which
  `release` uses until moq.pro's Land release quest deletes it, so the own
  queue's build workflow takes another name, or moq.pro renames the label
  queue's first. The own queue's trigger must not depend on that name: it
  builds `quest-queue/main/<number>` on push, as moq-dev/quest's `queue.yml`
  header shows.
- The watcher decides each build from `main`'s required checks other than
  `quest land`, reported on the queue branch's commit, and refuses to run
  while there are none. So `main`'s ruleset also requires the queue workflow's
  result job, which reports skipped on pull requests, as moq-dev/quest's
  `Queue` does.
- The own queue's token asks moq-bot's App for `actions: write` (to cancel a
  stale build) and `checks: write` (each pick's `quest queue` check run),
  beyond what the gate uses; grant them on moq.pro's installation first.
- Drain or carry over the gate's queue before switching: picks already armed
  stay armed, so the watcher reads them in the same order. Switch only once
  the gate has no fixer job running or uncollected: the gate records each in
  a `fix-job-*.json` file (`src/cli/land-fixer.ts`), while the watcher
  collects only its own `watch-job-*.json` files
  (`src/cli/land-watch-fix.ts`), so a gate fixer's result would be lost.
- The `moq-pro-gate` runner (`modules/ci-runners.nix` in kixelated/nixos)
  already serves moq.pro's Actions. Its runner group should admit only the
  queue workflow, as
  [Harden the queue runners](/quest/m0/queue-watcher/runners.md) does for the
  public queues.
