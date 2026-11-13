# [S] Agent admission is measured on a real fan-out

## Goal

A `/quest-spawn` fan-out on the maintainer's host, run with agent admission,
is compared with the three weeks before it: usage-limit errors, agents lost
to them, gate waits over 10 and 30 minutes, and total wall time. The numbers
go in this quest's PR, with any change to admission they call for.

## Plan

Baseline, from transcripts on the maintainer's three Linux hosts, 2026-10-22
to 11-12: fan-outs of 20 to 26 sub-agents; 157 "All credentials ... cooling
down" errors on one host; 156 background agents "terminated early due to an
API error"; and of 2,482 gated commands on one host, 191 waited over 10
minutes, 77 over 30, and 11 were still queued at the 55-minute timeout.

[moq-dev/quest#692](https://github.com/moq-dev/quest/pull/692) could not run
one: every host's load was above its CPU count, with gated commands queued,
so admission held every agent, which is its job and no fan-out.

Agent's choices, for the implementer to revisit:

- Give each agent its own `QUEST_GATE_RECORD` file, and read the waits from
  those rather than from transcripts.
- Check that the 5 minutes an admitted agent counts against the host
  (`PENDING_MS` in `src/cli/admission.ts`) still covers three quarters of the
  agents that gate anything, and that waves of admissions do not arrive at
  the gate together.

## Required

- [The gate records each run for the process that started the agent](/quest/m0/gate-record.md) - each agent's gate waits, read without matching transcripts
