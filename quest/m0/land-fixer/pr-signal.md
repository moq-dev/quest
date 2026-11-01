# [S] The fixer and /quest-merge read a PR's own CI as a signal

## Goal

A PR's own GitHub CI results inform the people and agents that land it,
without gating anything. `/quest-merge` shows the head's non-required check
results to whoever picks the PR, and the land fixer receives each batch PR's
check results, with the failing runs' logs, as extra context when it triages a
failing batch. Quest's landing docs state the policy: a public repository may
run PR CI as a free signal, and a private one relies on the host gate alone.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan): "I think for moq we should
re-enable Check being run on PRs [...] maybe could at least gate the PR making
it to the fixer? Or not gate at all, and would just be a signal to the fixer
(or whoever decided to quest-merge in the first place). (open source repos do
this because it's free, closed source do not)". moq-dev/moq plans its side in
`quest/m0/ci/pr-check.md`.

- The PR CI's role:
  - ✅ A signal only
  - Gate the fixer: a queued PR sits out batches until its CI finishes
  - A required check
- Record the public/private policy:
  - ✅ In quest's landing docs
  - In moq only

`quest status` already lists a PR's checks. `/quest-merge` should say when a
non-required check failed on the head it is about to pick, without refusing.
The fixer gets a summary per PR (check name, conclusion, run URL, and a
trimmed log of each failure) in its job input, next to the batch log. A
failing non-required check never parks or ejects a PR on its own; the parked
case is only for required checks, in
CI failures park (`quest/m0/land-fixer/ci-park.md`), which
[moq-dev/quest#363](https://github.com/moq-dev/quest/pull/363) plans.

## Related

- Batch triage ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)) - where the fixer uses the signal
