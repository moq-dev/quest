# [S] A gated command cannot exhaust the host's memory

## Goal

On Linux hosts where the gate owns each command in a systemd scope, a
gated command that grows past its memory ceiling is throttled and then
killed as a whole group, instead of the kernel's OOM killer picking a
victim elsewhere on the host. Other gated commands, agent sessions, and
host services keep running.

Non-goals: host-wide swap or oomd settings, which kixel-ai/nixos's
quest tree plans for the maintainer's host.

## Plan

Found 2026-11-12 in read-only audits of the maintainer's three Linux
hosts: the kernel OOM killer fired 5 times in 10 days on one host, killing a
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

What the decision requires, found in review:

- The ceilings of commands running at once must fit the host together:
  per-command ceilings each sized from the memory available at admission
  overcommit, since several commands admitted together each see the same
  free memory. Partition one host budget (memory less a reserve for
  sessions and services) across admitted commands, as the gate's memory
  admission already counts each command's share (`COMMAND_MEMORY` in
  `src/cli/gate.ts`), and admit a command only when its ceiling fits.
- A nested gate's scope is a sibling bound to its enclosing scope
  (`BindsTo`), not a child cgroup, so it does not inherit the parent's
  limit: its usage must come out of the enclosing command's share.

Agent's choices, for the implementer to revisit:

- Set `MemoryHigh` below `MemoryMax`, so a command slows under reclaim
  before it is killed, and `OOMPolicy=kill`, so an OOM kill inside the
  scope stops the whole command rather than leaving its wrappers running.
- Size a command's share from its measured peak once the gate has seen
  it, rather than a constant (moq-dev/quest#673 dropped the matching CPU
  plan); a command
  that needs more fails loud with the scope's OOM event in the gate's
  error, so the agent learns why.

## Hosts

- linux - systemd scopes carry the memory limits

## Related

- [Coordinators start an agent only when the host and the account can carry it](/quest/m0/agent-admission.md) - the agent-level half of host admission
