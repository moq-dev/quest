# The land fixer handles every mechanical failure itself

## Goal

The land gate dequeues a PR only when a decision is required, and lands as
many PRs as it safely can. When a batch fails or a queued PR conflicts, the
gate and its fixer resolve every mechanical cause themselves and land the
result, so a maintainer sees only behavior and design decisions.

- Nothing leaves the queue for a conflict or a failure. A PR the fixer is
  working on keeps its auto-merge and its place, sits out batches until the
  fix is in, and leaves the queue only when the fixer hands it back. The fixer
  blames the failing PR before anything else happens, and a pick's single
  attempt is spent only on a fix that failed.
- Broken PRs stay out of batches. The daemon runs `quest check` on a batch's
  chain before the sandbox, and pre-checks queued PRs against the base while
  a batch runs. Batch size follows the measured failure rate.
- The fixer starts from the base with internet access and the batch's PRs and
  head SHAs. It ignores instructions in their diffs, builds and tests its
  fixes, and pushes them onto the PRs' branches. The daemon posts the
  comments the fixer writes into its result.
- The gate merges locally instead of trusting GitHub's mergeability, and
  reruns a failed module before blaming. A rerun-proven flaky test is
  disabled in a separate PR with a follow-up quest.
- Protected paths stay blocked for the fixer's own edits. A fixer-written
  protected edit, or a push GitHub refuses, comes back as a ready commit the
  maintainer applies with one command.

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
| 98 | "already used its mechanical fix attempt" after a collateral requeue or an earlier conflict fix; each needed a manual re-pick | [Attempt budget](/quest/m0/land-fixer/attempts.md), [Batch triage](/quest/m0/land-fixer/triage.md) |
| ~75 | "requeued unchanged": collateral of a batch another PR broke | [Batch triage](/quest/m0/land-fixer/triage.md) |
| 36 | picked again while fixing; the newer pick is kept, so nothing is lost | not planned |
| 17 | conflicts in protected paths (`flake.nix`, `.github/`), mostly mechanical; resolved by hand on moq-dev/moq#7344, #7315, #7318 | blocked by design; fixer-written protected edits become a ready commit ([Fork commits](/quest/m0/land-fixer/fork-commit.md)) |
| 17 of the last 40 jobs | `cargo` fails offline ("failed to get `uniffi`"), so Rust fixes were requeued uncompiled: moq-dev/moq#7357 sank three batches, and #6985's lockfile could not be regenerated | fixed by [moq-dev/quest#356](https://github.com/moq-dev/quest/pull/356): the prompt allows dependency fetches and requires a build and test |
| 2 | GitHub refused the push to a fork because the merge touches workflows: moq-dev/moq#7439, #7467 | [Fork commits](/quest/m0/land-fixer/fork-commit.md) |
| several batches | a flaky ffmpeg timeout ([moq-dev/moq#7480](https://github.com/moq-dev/moq/pull/7480)) ejected whole batches | [Flaky tests](/quest/m0/land-fixer/flaky.md) |
| ~15 | design conflicts, correctly handed back | none |

Decision prompts, selected options marked ✅:

- Goal: "the fixer resolves every mechanical failure on its own"
  - Yes, as stated (triage and local mergeability stay separate)
  - Narrower: only the attempt budget and offline builds
  - ✅ Broader: also fold [Batch triage](/quest/m0/land-fixer/triage.md)
    and [Local mergeability](/quest/m0/land-fixer/mergeability.md) into
    this epic
- How attempts count: see [Attempt budget](/quest/m0/land-fixer/attempts.md).
- How the fixer gets dependencies:
  - Host prefetches the job's lockfile dependencies and mounts them read-only
  - ✅ Allow registry network. The host already gave the fixer container
    public egress; `assets/land-fix.md`'s "never contact GitHub" made it
    build `--offline`. [moq-dev/quest#356](https://github.com/moq-dev/quest/pull/356)
    allows fetches from package registries and `github.com`/`codeload.github.com`
    and makes the fixer build and test what it reports.
  - Leave it
- Protected paths: the fixer first could edit them (moq-dev/quest#357), then not; see the 2026-11-01 audit below.
- Fork pushes GitHub refuses: see [Fork commits](/quest/m0/land-fixer/fork-commit.md).
- Flaky tests: see [Flaky tests](/quest/m0/land-fixer/flaky.md).
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
  - GitHub comments: the daemon posts them · ✅ a comment-only token · both
  - Workflow pushes: ✅ grant moq-bot `workflows` · the fixer avoids
    workflows
- The user, starting the work: "The fixer is meant to handle conflicts and
  failures without kicking stuff out of the queue." A conflict or a failing
  check therefore never ejects a PR; the gate parks it (no auto-merge change,
  no ejection comment) while its fixer job runs, and only a handback
  disables auto-merge. [Batch triage](/quest/m0/land-fixer/triage.md) and
  [Local mergeability](/quest/m0/land-fixer/mergeability.md) follow this
  rule.

The README's landing section and `CONTRIBUTING.md` list what the fixer
resolves itself and what it hands back; that docs update finishes the epic.

- Audit of the merge-queue plan, 2026-11-01 (an independent read-only
  agent; the maintainer then decided each point). On moq over 24 hours: 128
  landed and 390 ejected; 66 of 138 sandbox checks failed; batches stayed at
  2-3 PRs. The binding bottleneck is the batch failure rate, roughly 20-25% of
  PRs broken against the current base, and not fixer capability. Decisions:
  - Protected paths: ✅ keep `validateFix`'s block and route fixer-written
    protected edits through [Fork commits](/quest/m0/land-fixer/fork-commit.md)'s
    ready commit; moq-dev/quest#357 closed · keep #357 · #357 minus workflows
  - Fixer comments: ✅ the daemon posts them from the fixer's result, no
    token in the container (moq-bot comments carry trust: `quest land apply`,
    the daemon's markers, `quest status`) · keep the token
  - Flaky tests: ✅ disable only a rerun-proven flaky test, in a separate PR
    · keep the fixer's judgment and the base PR
  - New work, all picked: ship [Attempt budget](/quest/m0/land-fixer/attempts.md)
    right after triage; [the batch check](/quest/m0/land-fixer/batch-check.md);
    [pre-checks](/quest/m0/land-fixer/precheck.md); and
    [tuning](/quest/m0/land-fixer/tuning.md)

## Required

- [Batch triage](/quest/m0/land-fixer/triage.md) - the fixer blames the failing PR before ejection, and a red base halts the queue
- [Attempt budget](/quest/m0/land-fixer/attempts.md) - only a fix that fails again spends a pick's single attempt
- [Batch quest check](/quest/m0/land-fixer/batch-check.md) - the daemon runs `quest check` on the batch's chain before spending a sandbox check
- [Pre-check queued PRs](/quest/m0/land-fixer/precheck.md) - compile and lint the next PRs against the base while a batch runs, parking broken ones before they batch
- [Throughput tuning](/quest/m0/land-fixer/tuning.md) - batch size from the failure rate, no wasted base-conflict rounds, rerere, a fixer cap, and an explicit reasoning effort
- [Workflow permission](/quest/m0/land-fixer/workflows-permission.md) - waits on the maintainer to grant moq-bot `workflows`, so pushes touching workflows are accepted
- [Fixer comments](/quest/m0/land-fixer/comments.md) - the fixer writes comments into its result and the daemon posts them; no token enters the container
- [Flaky tests](/quest/m0/land-fixer/flaky.md) - the gate reruns a failed module, and a rerun-proven flaky test is disabled in a separate PR with a follow-up quest
- [Local mergeability](/quest/m0/land-fixer/mergeability.md) - `quest land` merges with the quest driver instead of ejecting on GitHub's conflict flag
- [Fork commits](/quest/m0/land-fixer/fork-commit.md) - a fork push GitHub refuses hands back a commit a maintainer session applies as is
- [Protected edits as ready commits](/quest/m0/land-fixer/protected-commit.md) - a fixer edit `validateFix` rejects for touching protected paths comes back as a commit the maintainer applies

## Related

- [Merge through a host gate](/quest/m0/host-land/README.md) - the gate and fixer this epic extends
