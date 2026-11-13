# [M] The gate records each run for the process that started the agent

## Goal

When `QUEST_GATE_RECORD` names a file, every outermost `quest gate` run
on Linux or macOS appends one JSON line to it, however the run ends,
with the command, its directory, how long it waited for admission, its
CPU time, wall time, peak memory, and exit status. When it is unset, the
gate writes nothing.

A process that starts an agent, such as a job runner or a CPU audit,
sets the variable in that agent's environment and reads back what the
agent's gated commands waited for and cost, including those its parallel
shells and subagents ran. Today that takes matching agent transcripts
against systemd journal lines, which hold no wait time and exist only on
Linux.

Non-goals: how the gate admits commands, which
[moq-dev/quest#667](https://github.com/moq-dev/quest/pull/667) plans
through mbx's pool; Windows, which
[its own quest](/quest/m1/gate-record-windows.md) covers; and any view of
the record in Quest itself.

## Plan

Decided 2026-11-12 (maintainer, `/quest-plan`):

- ✅ An environment variable names the file, and the reader owns it
  (rejected: every gate always appending to a per-host log under
  Quest's cache directory, tagged with an ID the reader filters by,
  which needs rotation and retention for history nothing reads). A
  reader that wants each agent apart gives each agent its own file.
- ✅ Linux and macOS here, Windows in m1 (rejected: Windows here too,
  since m0 leaves native Windows and its suite to m1; recording only
  wait, wall time, and exit status on Windows with no plan for the
  rest). The first answer was every platform; review found Windows
  conflicts with m0's scope and needs a new channel out of the job stub,
  so the maintainer split it.
- ✅ Where the gate owns the command only as a process group (macOS, and
  Linux without a systemd user manager), record a labeled lower bound:
  the CPU of the processes the gate reaped, and the largest single
  process's peak memory (rejected: sampling the group every few seconds,
  which costs more code and still misses short-lived processes). The
  README says these exclude processes the gate kills at the end, such as
  a leftover background server.
- ✅ Only outermost runs are recorded. A gate inside an admitted command
  (`QUEST_GATE_ADMITTED`) runs at once and is measured as part of it,
  so recording it too would count its CPU twice.
- ✅ m0 (rejected: m1), with the rest of the gate's work.

Agent's choices, for the implementer to revisit:

- One line per run: `command` (argv), `directory` (absolute), `started`,
  `admitted` (null when the run never was), and `ended` as ISO
  timestamps, `cpuMs`, `peakMemory` in bytes (null when the host cannot
  say), `measured` (`cgroup` or `children`, naming the source above; the
  Windows quest adds `job`),
  `exit` (the status the gate returns, 128 plus the signal's number for
  a signalled command, as the owners already map it), `cancelled`, and
  `error` (the gate's own failure, such as a command that cannot start
  or a scope it cannot confirm stopped). Wait and wall time follow from
  the timestamps. Nothing is in production, so the format carries no
  version.
- `ended` is when the command's own process exits, before the gate stops
  descendants it left behind, so cleanup does not count as wall time.
- On Linux with a systemd scope, the counters must outlive the command:
  the scope runs with `--collect`, and `vacated` in
  `src/cli/supervise.ts` already succeeds when systemd has removed the
  emptied cgroup, so a read after the command's tree exits can find
  nothing, and the 5-second CPU samples miss a short command and the
  last interval. Recommended: the handshake shell stays in the scope as
  a holder instead of becoming the command, and runs the command in a
  child cgroup of the scope, which is delegated (`Delegate=yes`) with no
  controllers enabled below it, so the scope's own `cpu.stat`
  `usage_usec` and `memory.peak` cover everything the command started.
  The owner stops the command's leftovers with the child's
  `cgroup.kill`, reads the scope's counters while the holder keeps it
  populated, then releases the holder and returns the counters with the
  exit status. The holder writes the command's exit status and the time
  it exited to the handshake's report pipe as soon as the command exits,
  since the owner otherwise sees only the holder's exit, after cleanup. An implementer may prove another way instead, such as
  holding a D-Bus reference to the unit and reading systemd's
  `CPUUsageNSec` and `MemoryPeak`; the short-command test below decides.
  `memory.peak` needs Linux 5.19, so on 5.14 to 5.18 `peakMemory` is
  null.
- On a process group, `cpuMs` and `peakMemory` come from the command's
  rusage at exit, which `wait4` reports for it and the descendants it
  waited for. Node's `child_process` exposes none; Bun's
  `Subprocess.resourceUsage()` does, so the group owner may need to
  start its command through `Bun.spawn`.
- Append each line in one write to a file opened for append, since an
  agent's parallel shells and subagents share it.
- A cancelled run, including one cancelled while waiting for admission,
  still writes its line. A line that cannot be written fails the gate:
  it names the file on stderr and exits nonzero, keeping a cancellation's
  status when the run was cancelled.
- The record holds what the agent's own processes wrote. The agent's
  shell already has the variable and can write the file directly, so
  removing it from gated commands' environment would protect nothing;
  the README says a record is as trustworthy as the agent.
- Document the variable, the line format, and what each platform counts
  in the README's gate section.

Tests: an outermost run under the variable appends one line whose wait,
CPU, wall time, and exit match a stub command's, including one that ends
before the first CPU sample; a nested gate adds none; an unset variable
writes nothing; a run cancelled while queued for admission is recorded
with no admission; an unwritable file fails the gate; a process group's
line is labeled `children`; and concurrent gates leave only whole lines.

## Hosts

- linux - the systemd scope's cgroup accounting
- macos - the process group's rusage
