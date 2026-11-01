# [S] Admit gated commands on loaded CI runners

## Goal

`quest gate` admits commands on hosted CI runners whose load average sits
above their CPU count. On GitHub's arm64 macOS runners, a gated command no
longer waits until the job times out.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from a 25-PR /quest-complete run), from [moq-dev/quest#261](https://github.com/moq-dev/quest/pull/261).
The 1-minute load average on GitHub's `macos-14` runners stays above their 3
CPUs, so an end-to-end check through `quest gate` waited out a 10-minute job.
#261 dropped that check, and its owner tests skip admission.

- Find out why the load stays high (runner agents, Spotlight, virtualization)
  before choosing a fix. Options: a CI-aware baseline, admitting when nothing
  else holds a slot, or measuring load relative to the idle baseline.
- Restore an end-to-end gated check on that runner as the regression.

## Related

- [Gate bench](/quest/m0/gate-bench.md) - idle-host admission measurements
