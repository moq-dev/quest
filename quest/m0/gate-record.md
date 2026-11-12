# [M] The gate records each run for the process that started the agent

## Goal

When `QUEST_GATE_RECORD` names a file, every outermost `quest gate` run
appends one JSON line to it with the command, its directory, how long it
waited for admission, its CPU time, wall time, peak memory, and exit
code, on Linux, macOS, and Windows. When it is unset, the gate writes
nothing.

A process that starts an agent, such as a job runner or a CPU audit,
sets the variable in the agent's environment and reads back what that
agent's gated commands waited for and cost. Today that takes matching
agent transcripts against systemd journal lines, which hold no wait time
and exist only on Linux.

Non-goals: how the gate admits commands, which
[moq-dev/quest#667](https://github.com/moq-dev/quest/pull/667) plans
through mbx's pool, and any view of the record in Quest itself.

## Plan

Decided 2026-11-12 (maintainer, `/quest-plan`):

- ✅ An environment variable names the file, and the reader owns it
  (rejected: every gate always appending to a per-host log under
  Quest's cache directory, tagged with an ID the reader filters by,
  which needs rotation and retention for history nothing reads).
- ✅ Every platform the gate runs on (rejected: Linux only, where
  systemd scopes make CPU and memory cheap to read, since agents also
  run on macOS hosts).
- ✅ Only outermost runs are recorded. A gate inside an admitted command
  (`QUEST_GATE_ADMITTED`) runs at once and is measured as part of it,
  so recording it too would count its CPU twice.
- ✅ m0 (rejected: m1), with the rest of the gate's work.

Agent's choices, for the implementer to revisit:

- One line per run, written once after the command ends: `command`
  (argv), `directory` (absolute), `started`, `admitted`, and `ended` as
  ISO timestamps, `cpuMs`, `peakMemory` in bytes, and `exit` (the exit
  code, or the signal or cancellation that ended it). Wait and wall time
  follow from the timestamps. Nothing is in production, so the format
  carries no version.
- Measure where the gate already owns the command: on Linux, the scope's
  cgroup (`cpu.stat` `usage_usec`, `memory.peak`); on Windows, the Job
  Object's accounting and peak job memory; on macOS and Linux without a
  systemd user manager, the process group's rusage. Check first whether
  a process group's reaped children cover every descendant, and say in
  the README what each platform counts.
- Append each line in one write to a file opened for append, since
  several agents' gates can share one file. A test runs gates at once
  against one file and reads back whole lines.
- A record that cannot be written fails the gate after its command ends,
  as a failed measurement already does, rather than losing it quietly.
- Document the variable and the line format in the README's gate
  section.

Tests: an outermost run under the variable appends one line whose wait,
CPU, wall time, and exit code match a stub command's; a nested gate adds
none; an unset variable writes nothing; a cancelled run is recorded as
cancelled; and concurrent gates leave only whole lines.
