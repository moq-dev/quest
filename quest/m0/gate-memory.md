# [S] A gated command cannot exhaust the host's memory

## Goal

On Linux hosts where the gate owns each command in a systemd scope, a
gated command that grows past its memory ceiling is throttled and then
killed as a whole group, instead of the kernel's OOM killer picking a
victim elsewhere on the host. Other gated commands, agent sessions, and
host services keep running.

Non-goals: how the gate admits commands by memory, which stays as
[gate-mbx-pool](/quest/m0/gate-mbx-pool.md) leaves it, and host-wide
swap or oomd settings, which the maintainer's host repository plans.

## Plan

Found 2026-11-12 in read-only audits of the maintainer's three Linux
hosts (measurement record:
[moq-dev/kixel.quest#9](https://github.com/moq-dev/kixel.quest/pull/9)):
the kernel OOM killer fired 5 times in 10 days on one host, killing a
47 GB `rust2-ts` inside a gate scope, a 36 GB `lean`, and a 38 GB gated
`java` while a different process was the one allocating. earlyoom killed
34 processes in a week on another, including HOL Light, lean, and an
Apalache run with a 16 GB heap. Gate scopes start with no memory limit
(`systemd-run` in `src/cli/supervise.ts`).

Decided 2026-11-12 (maintainer, /quest-plan):

- ✅ The gate's scopes get a memory ceiling and kill the whole group on
  OOM (rejected: leaving it to host-wide oomd alone, which picks victims by
  pressure, not by which command overran; rules telling agents to cap
  heaps themselves).
- Milestone: ✅ m0 (rejected: m1).

Agent's choices, for the implementer to revisit:

- Set `MemoryHigh` below `MemoryMax`, so a command slows under reclaim
  before it is killed, and `OOMPolicy=kill`, so an OOM kill inside the
  scope stops the whole command rather than leaving its wrappers running.
- Derive the ceiling from the host at admission, such as the memory
  available then minus a reserve for the rest of the host, rather than a
  constant; a command that needs more fails loud with the scope's OOM
  event in the gate's error, so the agent learns why.
- A nested gate inherits its enclosing scope's ceiling.

## Related

- [The gate admits work through mbx's pool](/quest/m0/gate-mbx-pool.md) - keeps the memory admission this builds beside
- [Coordinators start an agent only when the host and the account can carry it](/quest/m0/agent-admission.md) - the agent-level half of host admission
