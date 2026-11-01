# [M] The gate reruns a failure, then disables a flaky test

## Goal

When a batch's check fails, `quest land` reruns the failing check modules
once on the same tip before blaming or ejecting anything. A test that failed
and then passed, or whose failure the fixer judges nondeterministic (for
example a timeout under load, or a race), is flaky. The fixer pushes one
commit onto the batch's base PR that disables the test with a reason and adds
a follow-up quest to fix or delete it in the repository's m0 `flaky` epic.
The batch then lands with that commit.

## Plan

Decided 2026-11-01 (user, /quest-plan of the land fixer audit; see the
[epic](/quest/m0/land-fixer/README.md)). A flaky ffmpeg render timeout in
moq's interop tests ejected whole batches on 2026-11-01. The fixer then
recognized it as flaky, but only after the batch's PRs had been ejected and
their attempts spent. The fix ([moq-dev/moq#7480](https://github.com/moq-dev/moq/pull/7480))
was written and landed by hand.

- What the gate does with a flaky failure:
  - ✅ Rerun the failed module once
  - The fixer names the flake
  - Nothing new
- User follow-up: "make a rule to immediately disable any flakey tests and
  create a follow-up to fix/delete them".
- Who disables:
  - The fixer opens and queues its own PR
  - The fixer opens a PR, and a maintainer picks it
  - Inside the next batch: the gate adds the skip commit to the batch it
    lands next, tested with it (picked first, then superseded)
  - ✅ Superseded 2026-11-01 (user, second /quest-plan): the fixer pushes the
    disabling commit, with its investigation quest, onto the batch's base PR,
    so it lands with this batch: "disable the flaky test in the base PR".
- What counts as flaky:
  - Only a rerun that passes
  - ✅ A rerun that passes, or a failure the fixer judges nondeterministic
- Where the follow-up goes:
  - ✅ A standing `flaky` epic in the repository's m0, one quest per
    disabled test
  - The earliest milestone, ungrouped
  - m1

How the gate reruns one module is up to the repository. `quest land` passes
the failed module names to the check command (for example through
`QUEST_LAND_RERUN`). A check command that ignores them reruns whole. moq's
`sh/dispatch.sh` already reports `ci: <action> <module> failed`.

The fixer writes the skip in the test framework's own form, with the reason
naming the follow-up quest: `#[ignore = "flaky: /quest/m0/flaky/<name>.md"]`,
`test.skip`, `pytest.mark.skip`, and so on. A disabled test that is a quest's
acceptance test still counts as its quest's work. The follow-up quest's Goal
says to fix the test or delete it, and links the batch logs that showed the
flake.

Flaky verdicts never spend a PR's attempt
([Attempt budget](/quest/m0/land-fixer/attempts.md)), and a batch whose only
failure was flaky lands without ejecting anyone. Since batch triage
([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)), a failing batch's PRs are parked
for the fixer rather than ejected; the rerun comes before that.
