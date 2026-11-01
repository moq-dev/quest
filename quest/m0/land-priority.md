# [S] Landing and cheap checks are admitted ahead of agent load

## Goal

On a loaded host, a cheap check such as `quest check` or a formatter waits
at most a short bounded time in `quest gate`, and the land daemon's batch
check is admitted ahead of agent builds. The queue keeps landing even while
agents load the host.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from a moq-dev/moq
`/quest-complete` run). With load between 33 and 67, cheap checks waited an
hour behind `quest gate`
([moq-dev/moq#7250](https://github.com/moq-dev/moq/pull/7250),
[moq-dev/moq#7257](https://github.com/moq-dev/moq/pull/7257)). On
2026-10-31 the land daemon sat idle from 05:07Z until after 06:45Z, with
about 80 PRs queued, while agent gates kept the host loaded.

- Cheap checks: admit them after a bounded wait, or let them bypass the
  gate. Decide how a command qualifies: a flag the caller passes, or a
  duration it declares. Do not keep a list of command names.
- Landing priority: the daemon's check comes before agent work. `admit` in
  `src/cli/gate.ts` takes no priority today, and the ledger is first come,
  first served. Find out whether the batch check reaches the gate through the
  host's sandbox launcher, then add a priority class or reserve a slot for
  it.
- Keep the gate's purpose: an unbounded bypass would let agent builds starve
  the host again.

## Related

- [Gate bench](/quest/m0/gate-bench.md) - admission measurements on an idle host
