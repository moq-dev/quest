# [XS] Measure gate headroom on an idle host

## Goal

The gate's idle-host behaviour is measured: `scripts/gate-bench.sh gated 8`
and `ungated 8` run on an otherwise idle host, and the results are recorded
in a PR. A gated burst that starts together, close to the ungated makespan,
confirms headroom admission; anything else becomes a follow-up.

## Plan

Decided 2026-10-22 (user) as a follow-up of
[moq-dev/quest#189](https://github.com/moq-dev/quest/pull/189), whose
benchmarks ran while other agents kept the host's load at 19-42 on 24 CPUs,
so they measured the busy-host path, not the idle burst the quest was for.
The earlier baseline, from
[moq-dev/quest#177](https://github.com/moq-dev/quest/pull/177), was 104 s
gated against 19 s ungated for a burst of 8.

- Run on a host with no other agents or builds; record the 1-minute load
  before each run alongside the results.
- Delete this quest in the PR that records the results.
- Dropped (user): asking Bun upstream to make `os.userInfo().homedir` ignore
  `$HOME` (the child-process lookup costs about 10 ms), and handling a macOS
  hostname that changes with the network, until it is seen in practice.
