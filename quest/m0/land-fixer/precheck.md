# [M] Queued PRs are pre-checked while a batch runs

## Goal

While a batch's check runs, the daemon pre-checks the next queued PRs, each
alone against the current base, with the repository's quick command (compile
and lint, not tests), at a lower priority than the batch check. A PR that
fails is parked for the fixer with the output before it enters a batch, so a
broken PR stops costing a whole batch.

## Plan

Decided 2026-11-01 (maintainer, from the audit of the merge-queue plan; see
the [epic](/quest/m0/land-fixer/README.md)). The audit found the batch
failure rate is the binding bottleneck: about half of moq's sandbox checks
failed, which means roughly 20-25% of PRs were broken against the current
base. A batch of k PRs lands about k·(1−p)^k PRs per check, so cutting p from
0.2 to 0.1 roughly doubles throughput. moq's `check rs` fails in about 26 s,
so a compile and lint pre-check catches most of these cheaply.

- The repository declares the pre-check command beside its check command
  (moq: something like `just check-changed <base>`). Run it in the same kind
  of sandbox as the batch check, never on the host.
- Run below the batch check's priority so it cannot slow the batch; the
  `land-priority` work already provides the priority classes.
- Pre-check a PR at most once per (head, base) pair; a moved base re-queues
  it for pre-check only when the PR is next in line.
- A pre-check failure parks the PR through batch triage's
  ([moq-dev/quest#355](https://github.com/moq-dev/quest/pull/355)) mechanism, and the fixer gets the pre-check log as its failure.
