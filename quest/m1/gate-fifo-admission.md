# [M] Gate admission is first come, first served

## Goal

`quest gate` admits waiting commands in arrival order, so no caller is passed
by commands that started waiting after it, and its wait is bounded by the work
queued ahead of it. The host's load and memory still decide when the head of
the queue starts. `quick`, `priority`, and `host` keep their meanings.

Today admission has no queue: every waiter polls the 1-minute load average and
available memory, and whichever sees room first starts. With about 12 agents
gating on one desktop, a diff-scoped `just check` that ran in 84 s waited 77
minutes to be admitted
([moq-dev/moq.pro#3751](https://github.com/moq-dev/moq.pro/pull/3751)).

## Plan

Decided 2026-11-09 (maintainer, `/quest-plan` of moq-dev/moq.pro#3751's
follow-up):

- Plan it: ✅ in m1, beside gate-cpu-weight, which yields gated commands'
  CPU to the interactive session (rejected: m0; drop).
- Mechanism: ✅ FIFO admission: waiters start in arrival order, with no cost
  estimate (rejected: shortest job first from measured costs, which needs a
  cost model and can starve full gates; a slot reserved for small commands;
  leaving the choice to the implementer).

The admission ledger (`src/cli/gate.ts`) already records each admission under
an atomic versioned publish; the queue can live in the same ledger, recording
each waiter when it starts waiting. A waiter whose gate process died leaves
the queue the way a dead admission leaves the ledger today. `quick` callers
still start after `QUICK_MS` whatever their place, and a `host` reservation
still holds everyone back. A `priority` caller, which today ignores load so it
goes first while the host is loaded, keeps going ahead of the queue rather than
taking a place in it.

`admit` drops a ledger entry once it is older than `RECENT_MS` and its process
no longer runs; a queued waiter's entry must stay while its gate lives, however
long it waits, and must not count as an admission against anyone's headroom.
`admit`'s doc comment, which today promises no fairness, states the new order.
