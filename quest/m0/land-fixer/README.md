# The land fixer handles every mechanical failure itself

## Goal

When a land batch fails or a queued PR conflicts, the gate and its fixer
resolve every mechanical cause themselves and land the result, so a
maintainer sees only behavior and design decisions. Nothing leaves the queue
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
| 17 of the last 40 jobs | `cargo` fails offline ("failed to get `uniffi`"), so Rust fixes were requeued uncompiled: moq-dev/moq#7357 sank three batches, and #6985's lockfile could not be regenerated | [Registry network](/quest/m0/land-fixer/network.md) |
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
- How the fixer gets dependencies: see [Registry network](/quest/m0/land-fixer/network.md).
- Protected paths: see [Protected edits](/quest/m0/land-fixer/protected.md).
- Fork pushes GitHub refuses: see [Fork commits](/quest/m0/land-fixer/fork-commit.md).
- Flaky tests: see [Flaky tests](/quest/m0/land-fixer/flaky.md).
- Milestone for the new quests: ✅ m0 · m1
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

- [Attempt budget](/quest/m0/land-fixer/attempts.md) - only a fix that fails again spends a pick's single attempt
- [Registry network](/quest/m0/land-fixer/network.md) - the fixer fetches dependencies, so it builds and tests what it requeues
- [Batch triage](/quest/m0/land-fixer/triage.md) - the fixer blames the failing PR before ejection, and a red base halts the queue
- [Flaky tests](/quest/m0/land-fixer/flaky.md) - the gate reruns a failed module, disables a flaky test in the next batch, and files a follow-up
- [Local mergeability](/quest/m0/land-fixer/mergeability.md) - `quest land` merges with the quest driver instead of ejecting on GitHub's conflict flag
- [Protected edits](/quest/m0/land-fixer/protected.md) - the fixer edits protected paths when it judges the edit mechanical, and the fix lands
- [Fork commits](/quest/m0/land-fixer/fork-commit.md) - a fork push GitHub refuses hands back a commit a maintainer session applies as is

## Related

- [Merge through a host gate](/quest/m0/host-land/README.md) - the gate and fixer this epic extends
