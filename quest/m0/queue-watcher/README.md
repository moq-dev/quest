# Land through GitHub's merge queue with an async fixer

## Goal

Each repository lands through GitHub's merge queue again, one PR at a time,
with no batching and no pre-checks. When the queue drops a PR for a failure
or a conflict, a watcher on the maintainer's host runs the existing Codex land
fixer in the background and re-enqueues the PR at the back of the queue. Only
a decision the fixer can't make reaches a person. moq-dev/moq moves first;
moq-dev/quest, moq.pro, rust2 and rind follow once moq proves it, and the
batching host gate (`quest land serve`) is then retired.

The epic finishes with an end-to-end run on moq-dev/moq: a PR the queue drops
for a failing build is fixed and re-enqueued, a PR dropped for a conflict is
resolved and re-enqueued, a flaky failure is re-enqueued unchanged, and a
design conflict is handed back. The README's landing section describes the
watcher.

Non-goals: moq's own switch (its ruleset, its `merge_group` workflow, the
runner label, and retiring its `quest land` requirement). moq-dev/moq plans
that in its tree, in
[Land main through GitHub's merge queue](https://github.com/moq-dev/moq/blob/main/quest/m0/ci/land.md),
rewritten by [moq-dev/moq#7589](https://github.com/moq-dev/moq/pull/7589).

## Plan

Decided 2026-11-01 (maintainer, /quest-plan), reversing the 2026-10-26
decision recorded in moq-dev/moq's `quest/m0/ci/land.md` to leave GitHub's
merge queue for a batched gate. That decision's main reason was that GitHub
cannot resolve quest-file conflicts: 71% of moq's 246 merge-conflict removals
touched `quest/`. The async fixer now absorbs those, resolving them with the
quest merge driver and re-enqueuing. The batched host gate measured about 4-6
merged PRs per hour at a 23% per-PR failure rate, with batches shrinking to
one PR; GitHub's serial queue measured 5.5.

Decision prompts, selected options marked ✅:

- Goal:
  - ✅ Yes, as stated: a serialized GitHub merge queue, with every failure
    fixed asynchronously and re-enqueued. Batching and pre-checks are
    dropped: on moq a useful pre-check must compile, which is most of a check.
  - Keep the host queue, serial
- Scope:
  - ✅ moq first, since it lands the most PRs and so proves the design
    fastest. moq-dev/quest, moq.pro, rust2 and rind stay on the host
    `quest land` gate until moq proves it, then
    [follow](/quest/m0/queue-watcher/follow.md).
  - All five at once
  - moq and quest
- Runners:
  - ✅ Self-hosted on nixos: `merge_group` builds run on the host's runner
    (kixelated/nixos `modules/ci-runners.nix`, runner `moq-ci`, label
    `moq-queue`), for warm caches and no GitHub minutes
  - GitHub-hosted
- Interim:
  - Keep improving the host gate
  - ✅ Freeze gate work: no more host-gate improvements except fixes the
    switch needs. Closed for it: [moq-dev/quest#376](https://github.com/moq-dev/quest/pull/376)
    (batch sizing), [#379](https://github.com/moq-dev/quest/pull/379) (batch
    quest check), [#375](https://github.com/moq-dev/quest/pull/375) (rerun
    before blame), [#377](https://github.com/moq-dev/quest/pull/377)
    (pre-checks) and [moq-dev/moq#7588](https://github.com/moq-dev/moq/pull/7588).
- Build concurrency:
  - ✅ 1, maybe 2: start the merge queue at build concurrency 1, and consider
    2 only with measured data. At 1, each `merge_group` holds exactly one PR
    on top of the base, so a failure blames that PR with no triage.
- Re-enqueue:
  - ✅ The back of the queue, so a PR being fixed never jumps PRs that
    passed
  - The front
- Attempts:
  - ✅ Unlimited while progressing; see
    [Stop rules](/quest/m0/queue-watcher/stop.md). This replaces batch
    triage's ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355))
    one attempt per pick.
- Flaky failures:
  - ✅ The fixer re-enqueues them unchanged, and a test seen flaking twice is
    disabled in a separate PR with a follow-up quest; the rerun before blame
    (#375) is dropped. See [Flaky failures](/quest/m0/queue-watcher/flaky.md).
- Picks GitHub refuses to enqueue:
  - ✅ The watcher fixes them, then enqueues; see
    [Bad picks](/quest/m0/queue-watcher/bad-picks.md)
- Milestone:
  - ✅ m0, at the top

Shared shape, for the children to follow:

- The watcher is a long-running host daemon, one per repository, that reuses
  the host gate's fixer infrastructure rather than a new one: moq-bot's App
  key through systemd `LoadCredential`, the ephemeral nspawn fixer container
  and its launcher, the detached fixer supervisor and its collection in
  `src/cli/land-fixer.ts`, `validateFix`'s protected paths, the ready-commit
  handback that `quest land apply` rebuilds, and the daemon posting the
  comments the fixer writes. A `quest land watch` subcommand beside
  `quest land serve` is the likely form; the first child settles it.
- The fixer prompt (`assets/land-fix.md`) and its quality quests stay in
  [the land fixer epic](/quest/m0/land-fixer/README.md); the host container
  work stays in [the host gate epic](/quest/m0/host-land/README.md).
- The review policy is unchanged: a head the fixer pushed as a recorded
  mechanical fix lands without a new review (maintainer, 2026-10-30). A push
  by anyone else ends the pick, as does a person removing the PR from the
  queue.
- moq's `merge_group` builds may call `quest gate`; the
  [landing priority](/quest/m0/land-priority.md) class
  (`QUEST_GATE_PRIORITY`) lets them admit ahead of agent load, set from moq's
  workflow or the runner's environment.

## Required

- [Queue removals](/quest/m0/queue-watcher/removals.md) - the watcher sees each PR the queue drops, why, and the failing build's log
- [Fix and re-enqueue](/quest/m0/queue-watcher/fix.md) - the fixer runs on each dropped PR in the background, and the watcher re-enqueues it at the back
- [Stop rules](/quest/m0/queue-watcher/stop.md) - the fixer keeps going while each round changes something, and hands back on a no-op fix, a repeated failure, or three flaky re-enqueues
- [Bad picks](/quest/m0/queue-watcher/bad-picks.md) - a pick GitHub refuses to enqueue is merged locally with the quest driver or fixed, then pushed and enqueued
- [Flaky failures](/quest/m0/queue-watcher/flaky.md) - a flaky failure is re-enqueued unchanged, and a test seen flaking twice is disabled in a separate PR with a follow-up quest
- [Watcher on the host](/quest/m0/queue-watcher/host.md) - kixelated/nixos runs the watcher for moq-dev/moq beside its fixer container
- [The other repositories follow](/quest/m0/queue-watcher/follow.md) - condition: moq's queue is proven; then moq-dev/quest switches and the others plan theirs
- [Retire the batching gate](/quest/m0/queue-watcher/retire.md) - once no repository lands through `quest land serve`, its batching code and host units go

## Related

- [The land fixer](/quest/m0/land-fixer/README.md) - the fixer the watcher runs
- [Merge through a host gate](/quest/m0/host-land/README.md) - the gate the other repositories keep until they follow
