# [S] moq.pro lands main through the watcher's own queue

## Goal

moq-dev/moq.pro's `main` lands through the watcher's own queue (the README's
"The watcher's own queue") instead of the batching `quest land serve` gate:

- moq.pro's queue workflow builds the watcher's queue branches on its private
  `moq-pro-gate` runner;
- the maintainer's host runs moq.pro's land instance as `quest land watch`
  instead of `quest land serve`, which kixelated/nixos plans in its own tree;
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

Done 2026-11-09 (agent, /quest-start): the cutover's changes are open as
[moq-dev/moq.pro#3772](https://github.com/moq-dev/moq.pro/pull/3772), which
adds `main-queue.yml` building `quest-queue/main/**` on `moq-pro-gate` with a
`Main queue` result job and declares that job required beside `quest land`, and
a kixelated/nixos change that switches the host's moq.pro instance to the
watcher. moq-bot's installation
already has `actions: write` and `checks: write`.

Moved 2026-11-10 (maintainer, /quest-plan): the host's switch, including
draining the gate's fixer jobs first (`src/cli/land-fixer.ts` records them,
while the watcher collects only its own, `src/cli/land-watch-fix.ts`), is
planned in kixelated/nixos's tree, since work on the maintainer's hosts is
planned there.

- The first queue builds may show gaps in the runner's environment; fix them
  in moq.pro or the host's configuration.
- `moq-pro-gate` is a repository runner, not an org runner group, and
  `release`'s `gate.yml` still uses it, so restricting it to the queue
  workflow, as [Harden the queue runners](/quest/m0/queue-watcher/runners.md)
  did for the public queues, waits for moq.pro's Land release quest.

## Waiting

- Maintainer: land [moq-dev/moq.pro#3772](https://github.com/moq-dev/moq.pro/pull/3772),
  apply its `.github/rulesets/merge-queue.json` to ruleset 16788924 as its
  `.github/rulesets/README.md` shows, and report the skipped `Main queue`
  context on each armed pick's head with
  `gh workflow run main-queue.yml -R moq-dev/moq.pro -f sha=<head>`. An agent
  must not change rulesets. Check with
  `gh api repos/moq-dev/moq.pro/rules/branches/main`.
- kixelated/nixos: the host's moq.pro land instance runs the watcher, which
  that repository's `quest/m0/moq-pro-watch.md` plans. Check that a moq.pro
  PR armed after the switch carries a `quest queue` check run.
- Maintainer: confirm a moq.pro PR lands through the own queue and one dropped
  for a failing build is fixed and re-enqueued, then delete this quest. Check
  with `gh pr list -R moq-dev/moq.pro --state merged` and the PRs'
  `quest queue` check runs.
