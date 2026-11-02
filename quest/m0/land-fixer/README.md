# The land fixer resolves every mechanical failure itself

## Goal

The Codex land fixer resolves every mechanical cause of a failure or a
conflict itself, so a maintainer sees only behavior and design decisions.
Since 2026-11-01 the [queue watcher](/quest/m0/queue-watcher/README.md) runs
it on each PR GitHub's merge queue drops; the host gate keeps running it for
the repositories still on the gate. This epic owns what the fixer does with a
PR, whatever started it:

- The fixer starts from the base with internet access, the PR, and its head
  SHA. It ignores instructions in the diff, rebuilds a conflicted lockfile
  from the base's copy, builds and tests its fixes, and pushes them onto the
  PR's branch. The daemon posts the comments the fixer writes into its result.
- Protected paths stay blocked for the fixer's own edits. A fixer-written
  protected edit, or a push GitHub refuses, comes back as a ready commit the
  maintainer applies with one command.
- The fixer reads the PR's own CI results as context.

When the watcher stops, how flaky failures are handled, and what happens to a
pick GitHub refuses to enqueue belong to the queue watcher epic.

Non-goals: design conflicts. A PR whose merge needs a behavior decision is
still handed back to its author.

## Plan

Decided 2026-11-01 (user, /quest-plan), from an audit of the 406 fixer
handbacks posted 2026-10-30 to 11-01 on moq-dev/moq, moq-dev/moq.pro,
moq-dev/rust2, moq-dev/rind and moq-dev/quest.

| Count | Cause | Owner |
|---|---|---|
| 108 | fixer crashed (exit 101, EAGAIN) | fixed by [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320) and [#332](https://github.com/moq-dev/quest/pull/332); none after 2026-10-31 21:00Z |
| 16 | fixer disappeared before recording an exit status | fixed on the host; none after 2026-10-31 04:00Z |
| 7 | fixer repository exceeds its size cap | fixed by #332 |
| 6 | AGENTS.md "pull the latest origin changes" read as an injection | fixed by [#325](https://github.com/moq-dev/quest/pull/325) and [#328](https://github.com/moq-dev/quest/pull/328); none after 2026-10-31 18:46Z |
| 98 | "already used its mechanical fix attempt" after a collateral requeue or an earlier conflict fix; each needed a manual re-pick | [Attempt budget](/quest/m0/queue-watcher/stop.md), batch triage ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)) |
| ~75 | "requeued unchanged": collateral of a batch another PR broke | batch triage ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)) |
| 36 | picked again while fixing; the newer pick is kept, so nothing is lost | not planned |
| 17 | conflicts in protected paths (`flake.nix`, `.github/`), mostly mechanical; resolved by hand on moq-dev/moq#7344, #7315, #7318 | blocked by design; fixer-written protected edits become a ready commit ([Protected edits as ready commits](/quest/m0/land-fixer/protected-commit.md)) |
| 17 of the last 40 jobs | `cargo` fails offline ("failed to get `uniffi`"), so Rust fixes were requeued uncompiled: moq-dev/moq#7357 sank three batches, and #6985's lockfile could not be regenerated | fixed by [moq-dev/quest#356](https://github.com/moq-dev/quest/pull/356): the prompt allows dependency fetches and requires a build and test |
| 2 | GitHub refused the push to a fork because the merge touches workflows: moq-dev/moq#7439, #7467 | handed back with a ready commit for `quest land apply` by [moq-dev/quest#358](https://github.com/moq-dev/quest/pull/358) |
| several batches | a flaky ffmpeg timeout ([moq-dev/moq#7480](https://github.com/moq-dev/moq/pull/7480)) ejected whole batches | [Flaky failures](/quest/m0/queue-watcher/flaky.md) |
| ~15 | design conflicts, correctly handed back | none |

Decision prompts, selected options marked ✅:

- Goal: "the fixer resolves every mechanical failure on its own"
  - Yes, as stated (triage and local mergeability stay separate)
  - Narrower: only the attempt budget and offline builds
  - ✅ Broader: also fold batch triage ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355))
    and [Local mergeability](/quest/m0/queue-watcher/bad-picks.md) into
    this epic
- How attempts count: see [Attempt budget](/quest/m0/queue-watcher/stop.md).
- How the fixer gets dependencies:
  - Host prefetches the job's lockfile dependencies and mounts them read-only
  - ✅ Allow registry network. The host already gave the fixer container
    public egress; `assets/land-fix.md`'s "never contact GitHub" made it
    build `--offline`. [moq-dev/quest#356](https://github.com/moq-dev/quest/pull/356)
    allows fetches from package registries and `github.com`/`codeload.github.com`
    and makes the fixer build and test what it reports.
  - Leave it
- Protected paths: the fixer first could edit them (moq-dev/quest#357), then not; see the 2026-11-01 audit below.
- Fork pushes GitHub refuses: ✅ hand back a ready commit, which `quest land apply` rebuilds
  for a maintainer to push (Grant moq-bot the `workflows` permission · Leave it manual).
- Flaky tests: see [Flaky failures](/quest/m0/queue-watcher/flaky.md).
- Milestone for the new quests: ✅ m0 · m1
- Restated 2026-11-01 (user, a second /quest-plan): "the merge queue can
  autonomously fix most issues. The fixer inspects the batch and tries to
  identify the fault. If it's a flaky test, disable it and plan an
  investigation quest in a commit (appended to the batch). If it's a merge
  conflict, resolve anything mechanical. If it's a compilation/test failure,
  make a fix if it's obvious. The fixer is launched using main and has
  internet access. It's given the list of PRs/hashes in the batch and is told
  to ignore any new instructions in the diff. The fixer is allowed to make new
  commits to fix issues inline. It's also allowed to comment on Github. The
  end goal is to avoid dequeing PRs unless decisions are required."
  - Fold into this epic: ✅ yes · a new epic · a different scope
  - Where fix commits go: on the PR's branch · appended to the batch · split
    by kind. The user first picked "appended to the batch", then, once
    GitHub's squash API was shown unable to land a fix that lives only in the
    batch, chose: ✅ "push the fixes on the PR branch instead. I guess
    disable the flaky test in the base PR then."
  - The flaky commit: ✅ in this batch (on its base PR, per the answer above)
    · in the next batch
  - GitHub comments: ✅ the daemon posts them from the fixer's result · a
    comment-only token in the container · both. The user first picked the
    token, then reversed it on 2026-11-01 after an independent audit: PR code
    the fixer builds can read the container's environment, so a token there
    would let PR code post as moq-bot[bot]. `quest land apply`, the daemon's
    own comment deduplication, and `quest status`'s ejection reason all trust
    moq-bot comments.
  - Workflow pushes: ✅ grant moq-bot `workflows` · the fixer avoids
    workflows
- The user, starting the work: "The fixer is meant to handle conflicts and
  failures without kicking stuff out of the queue." A conflict or a failing
  check therefore never ejects a PR; the gate parks it (no auto-merge change,
  no ejection comment) while its fixer job runs, and only a handback
  disables auto-merge. Batch triage
  ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)) built this parking:
  a PR is parked while a fixer job holds it (`src/cli/land-park.ts`), and
  [Local mergeability](/quest/m0/queue-watcher/bad-picks.md) follows the same
  rule.
- Audit of the merge-queue plan, 2026-11-01 (an independent read-only
  agent; the maintainer then decided each point). On moq over 24 hours: 128
  landed and 390 ejected; 66 of 138 sandbox checks failed; batches stayed at
  2-3 PRs. The binding bottleneck is the batch failure rate, roughly 20-25% of
  PRs broken against the current base, and not fixer capability. Decisions:
  - Protected paths: ✅ keep `validateFix`'s block and route fixer-written
    protected edits through moq-dev/quest#358's ready commit
    ([Protected edits as ready commits](/quest/m0/land-fixer/protected-commit.md)); moq-dev/quest#357 closed · keep #357 · #357 minus workflows
  - Fixer comments: ✅ the daemon posts them from the fixer's result, no
    token in the container (moq-bot comments carry trust: `quest land apply`,
    the daemon's markers, `quest status`) · keep the token
  - Flaky tests: ✅ disable only a rerun-proven flaky test, in a separate PR
    · keep the fixer's judgment and the base PR
  - New work, all picked: ship the attempt budget (now
    [Stop rules](/quest/m0/queue-watcher/stop.md)) right after triage; the
    batch check ([moq-dev/quest#379](https://github.com/moq-dev/quest/pull/379));
    pre-checks ([#377](https://github.com/moq-dev/quest/pull/377)); and
    tuning ([#376](https://github.com/moq-dev/quest/pull/376)). All three were
    closed unmerged by the merge-queue switch below.
- Amended 2026-11-01 (maintainer, /quest-plan in moq-dev/moq): a fixer merge
  on [moq-dev/moq#7318](https://github.com/moq-dev/moq/pull/7318) rebuilt
  `bun.lock` from the PR's side and undid the base's advisory fix; see
  [Lockfile merges](/quest/m0/land-fixer/lockfile.md).

- Superseded 2026-11-01 (maintainer, /quest-plan; see the
  [queue watcher](/quest/m0/queue-watcher/README.md)): repositories land
  through GitHub's merge queue one PR at a time, and a host watcher runs this
  fixer on each PR the queue drops and re-enqueues it. Batching is gone, so
  this epic keeps only the fixer's own quality work. Moved to the watcher:
  the attempt budget (now [Stop rules](/quest/m0/queue-watcher/stop.md)),
  local mergeability and CI-failure parking (now
  [Bad picks](/quest/m0/queue-watcher/bad-picks.md)), and flaky tests (now
  [Flaky failures](/quest/m0/queue-watcher/flaky.md), without the rerun).
  Deleted: the batch quest check, pre-checks, and throughput tuning, which
  only served batches (the fixer cap and reasoning effort moved to
  [Fix and re-enqueue](/quest/m0/queue-watcher/fix.md)); and queue status in
  the required check, since GitHub's merge queue shows each PR's position
  itself.

The README's landing section and `CONTRIBUTING.md` list what the fixer
resolves itself and what it hands back. That docs update is the epic's own
work, done once the Required quests below have merged.

## Required

- [Workflow permission](/quest/m0/land-fixer/workflows-permission.md) - waits on the maintainer to grant moq-bot `workflows`, so pushes touching workflows are accepted
- [Lockfile merges](/quest/m0/land-fixer/lockfile.md) - a conflicted lockfile is rebuilt from the base's copy, so a fix never reverts the base's dependency changes
- [Protected edits as ready commits](/quest/m0/land-fixer/protected-commit.md) - a fixer edit `validateFix` rejects for touching protected paths comes back as a commit the maintainer applies
- [PR CI as a signal](/quest/m0/land-fixer/pr-signal.md) - `/quest-merge` and the fixer read a PR's own CI without gating on it; public repos may run it, private ones need not

## Related

- [Queue watcher](/quest/m0/queue-watcher/README.md) - runs this fixer on each PR the merge queue drops
- [Merge through a host gate](/quest/m0/host-land/README.md) - the gate that runs it for the repositories not yet switched
