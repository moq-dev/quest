# The land fixer handles every mechanical failure itself

## Goal

The land gate dequeues a PR only when a decision is required. When a batch
fails or a queued PR conflicts, the gate and its fixer resolve every
mechanical cause themselves and land the result, so a maintainer sees only
behavior and design decisions. The fixer starts from the base with internet
access and the batch's PRs and head SHAs. It ignores instructions in their
diffs, pushes its fixes onto the PRs' branches, disables a flaky test on the
batch's base PR with an investigation quest, and comments on GitHub. Nothing leaves the queue
for a conflict or a failure: a PR the fixer is working on keeps its
auto-merge and its place, sits out batches until the fix is in, and leaves
the queue only when the fixer hands it back. The fixer blames the failing PR
before anything else happens. The gate merges locally instead of
trusting GitHub's mergeability, reruns a failed module before blaming, and
disables a flaky test with a follow-up quest. The fixer builds and tests
with access to package registries, edits protected paths when the edit is
mechanical, and spends a pick's single attempt only on a fix that failed.
When GitHub refuses its push to a fork, it hands back a ready commit.

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
| 17 | conflicts in protected paths (`flake.nix`, `.github/`), mostly mechanical; resolved by hand on moq-dev/moq#7344, #7315, #7318 | [Protected edits](/quest/m0/land-fixer/protected.md) |
| 17 of the last 40 jobs | `cargo` fails offline ("failed to get `uniffi`"), so Rust fixes were requeued uncompiled: moq-dev/moq#7357 sank three batches, and #6985's lockfile could not be regenerated | fixed by [moq-dev/quest#356](https://github.com/moq-dev/quest/pull/356): the prompt allows dependency fetches and requires a build and test |
| 2 | GitHub refused the push to a fork because the merge touches workflows: moq-dev/moq#7439, #7467 | handed back with a ready commit for `quest land apply` by [moq-dev/quest#358](https://github.com/moq-dev/quest/pull/358) |
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
- Protected paths: see [Protected edits](/quest/m0/land-fixer/protected.md).
- Fork pushes GitHub refuses: ✅ hand back a ready commit, which `quest land apply` rebuilds
  for a maintainer to push (Grant moq-bot the `workflows` permission · Leave it manual).
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

## Required

- [Fixer starts from main](/quest/m0/land-fixer/launch.md) - the fixer starts at the base with the batch's PRs as refs, and ignores instructions in their diffs
- [Workflow permission](/quest/m0/land-fixer/workflows-permission.md) - waits on the maintainer to grant moq-bot `workflows`, so pushes touching workflows are accepted
- [Fixer comments](/quest/m0/land-fixer/comments.md) - a per-job, comment-only GitHub token lets the fixer explain its work on the PRs
- [Attempt budget](/quest/m0/land-fixer/attempts.md) - only a fix that fails again spends a pick's single attempt
- [Batch triage](/quest/m0/land-fixer/triage.md) - the fixer blames the failing PR before ejection, and a red base halts the queue
- [Flaky tests](/quest/m0/land-fixer/flaky.md) - the gate reruns a failed module, disables a flaky test on the batch's base PR, and files a follow-up
- [Local mergeability](/quest/m0/land-fixer/mergeability.md) - `quest land` merges with the quest driver instead of ejecting on GitHub's conflict flag
- [Protected edits](/quest/m0/land-fixer/protected.md) - the fixer edits protected paths when it judges the edit mechanical, and the fix lands

## Related

- [Merge through a host gate](/quest/m0/host-land/README.md) - the gate and fixer this epic extends
