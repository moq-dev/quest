# Land through a serial merge queue with an async fixer

## Goal

Each repository lands through a serial merge queue, one PR at a time, with no
batching and no pre-checks: GitHub's merge queue where the repository has one,
and otherwise the watcher's own queue, such as on private moq-dev/moq.pro,
where GitHub Team offers none. When the queue drops a PR for a failure or a
conflict, a watcher on the maintainer's host runs the existing Codex land
fixer in the background and re-enqueues the PR at the back of the queue. Only
a decision the fixer can't make reaches a person. moq-dev/moq moves first;
moq-dev/quest, rust2 and rind follow once moq proves it, then moq.pro through
the own queue, and the batching host gate (`quest land serve`) is then
retired. kix.quest shows every repository's queue.

The epic finishes with an end-to-end run on moq-dev/moq: a PR the queue drops
for a failing build is fixed and re-enqueued, a PR dropped for a conflict is
resolved and re-enqueued, a flaky failure is re-enqueued unchanged, a test
seen flaking twice is disabled by a PR that lands through moq's queue with its
`quest/m0/flaky/` epic passing `quest check`, and a design conflict is handed
back. The README's landing section describes the watcher.

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
  - ✅ Unlimited while progressing, handing back on a round with no new
    commit for a failure that isn't flaky, the failure a fix addressed
    recurring right after it, or three flaky rounds in a row. This replaces
    batch triage's ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355))
    one attempt per pick; the host gate applies the same rules
    ([moq-dev/quest#384](https://github.com/moq-dev/quest/pull/384)).
- Flaky failures:
  - ✅ The fixer re-enqueues them unchanged, and a test seen flaking twice is
    disabled in a separate PR with a follow-up quest; the rerun before blame
    (#375) is dropped. Done in [moq-dev/quest#406](https://github.com/moq-dev/quest/pull/406).
    Refined 2026-11-03 (coordinator, /quest-complete follow-ups): a failure
    that reproduces on the base or comes from the runner is not a flaky
    verdict. Done in [moq-dev/quest#468](https://github.com/moq-dev/quest/pull/468).
    The end-to-end run covers the first disable PR, and the host gate gets
    no flaky record, since its work is frozen until it is retired.
- Pick record (decided 2026-11-02, replacing "Picks GitHub refuses to
  enqueue: ✅ The watcher fixes them"):
  - ✅ GitHub's records only. Drop the comment and `pick.ts`. The watcher
    reads queue events and auto-merge state. A pick GitHub refuses fails the
    command, and /quest-merge recommends /quest-iterate as it does today.
    Bad picks shrinks to enqueueing PRs with auto-merge armed that GitHub
    never queued, which `quest land watch` now does
    ([community#209348](https://github.com/orgs/community/discussions/209348)).
  - Comment only on refusal
  - Keep the comment on every pick

  Reasons: for queued picks, GitHub already keeps a durable,
  writer-authenticated record. `AddedToMergeQueueEvent` and
  `RemovedFromMergeQueueEvent` give the enqueuer (who must have write
  access), the head before removal, and the reason, and `autoMergeRequest`
  gives `enabledBy`/`enabledAt` for picks waiting on checks. Auto-merge can't
  reliably be armed on a conflicting PR, and on merge-queue bases enabling it
  returns HTTP 422 unless every requirement is met
  ([community#190610](https://github.com/orgs/community/discussions/190610),
  [community#50327](https://github.com/orgs/community/discussions/50327)).
  /quest-merge already refuses heads with failing checks or conflicts, so a
  refusal only happens if the base moves between that check and the enqueue.
  See `quest land watch` (`src/cli/land-watch.ts`, `enqueueArmed`).
- Milestone:
  - ✅ m0, at the top

Decided 2026-11-06 (maintainer, /quest-plan), since GitHub offers merge
queues on private repositories only under Enterprise Cloud and moq-dev is on
GitHub Team: moq.pro leaves the host gate for an own serial queue in
`quest land watch`, rather than a plan upgrade, making moq.pro public, or a
third-party queue. The maintainer expects the own queue to become every
repository's, for visibility. The decisions are recorded in
[the own queue](/quest/m0/queue-watcher/own-queue.md),
[moq.pro's cutover](/quest/m0/queue-watcher/pro-cutover.md) and
[the queue page](/quest/m0/queue-watcher/queue-page.md).

Shared shape, for the children to follow:

- The watcher is a long-running host daemon, one per repository (one per
  base once [per-base instances](/quest/m0/queue-watcher/per-base.md) land), that reuses
  the host gate's fixer infrastructure rather than a new one: moq-bot's App
  key through systemd `LoadCredential`, the ephemeral nspawn fixer container
  and its launcher, the detached fixer supervisor and its collection in
  `src/cli/land-fixer.ts`, `validateFix`'s protected paths, the ready-commit
  handback that `quest land apply` rebuilds, and the daemon posting the
  comments the fixer writes. A `quest land watch` subcommand beside
  `quest land serve` is the likely form; the first child settles it.
- The fixer prompt (`assets/land-fix.md`) stays as the finished land fixer epic left it.
- The review policy is unchanged: a head the fixer pushed as a recorded
  mechanical fix lands without a new review (maintainer, 2026-10-30). A push
  by anyone else ends the pick, as does a person removing the PR from the
  queue.
- moq's `merge_group` builds may call `quest gate`; the landing priority
  class (`QUEST_GATE_PRIORITY=1`, which waits for memory but never for load)
  lets them admit ahead of agent load, set from moq's workflow or the
  runner's environment.

## Required

- [The other repositories follow](/quest/m0/queue-watcher/follow.md) - quest, rind and rust2 are cut over and landing; waits for a fork PR to land through one of their queues
- [Harden the queue runners](/quest/m0/queue-watcher/runners.md) - each queue runner runs only its repository's queue workflow, and every outside fork PR needs approval
- [The watcher writes flaky quests](/quest/m0/queue-watcher/flaky-quest.md) - a disable's follow-up quest comes from a template in `quest land watch`, so the headless land fixer writes no quest
- [Daemons prune their logs](/quest/m0/queue-watcher/log-retention.md) - the watcher and gate delete their finished logs after a window, so state stays bounded (4.1 GiB on nixos on 2026-11-04)
- [The watcher runs its own serial queue](/quest/m0/queue-watcher/own-queue.md) - `quest land watch` lands a base without GitHub's merge queue, testing one pick at a time in the repository's queue workflow
- [moq.pro lands main through the own queue](/quest/m0/queue-watcher/pro-cutover.md) - moq.pro's `main` leaves the batching gate for the watcher's own queue
- [The watcher runs one instance per base branch](/quest/m0/queue-watcher/per-base.md) - each base of a repository gets its own watcher, clone, locks, state and `--method`, so moq.pro's `release` can follow `main`
- [Retire the batching gate](/quest/m0/queue-watcher/retire.md) - once no repository lands through `quest land serve`, its batching code and host units go
- [kix.quest shows each repository's landing queue](/quest/m0/queue-watcher/queue-page.md) - one page per repository with its queue order, current build, and recent drops, in both modes
