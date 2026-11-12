# [M] The gate's run record on Windows

## Goal

On Windows, `QUEST_GATE_RECORD` works as it does on Linux and macOS: each
outermost `quest gate` run appends one line, with CPU time and peak
memory taken from the Job Object that owns the command and everything it
starts.

## Plan

Decided 2026-11-12 (maintainer, `/quest-plan`): split from the
[gate run record](/quest/m0/gate-record.md), since m0 leaves native
Windows and its suite to m1.

The Job Object lives in the Bun stub that `src/cli/job.ts` runs, and it
ends with the stub, so the gate never holds it. The stub reads the job's
basic accounting (total user and kernel time) and its peak job memory
once the command exits, before it closes the handle, and passes them to
the gate over a channel of its own, such as an extra pipe, keeping the
command's stdio untouched. Without a job, which the stub only warns
about today, the line carries null CPU and memory.

Tests, in the native Windows suite: a stub command's line carries its
CPU and peak memory, a grandchild's CPU counts toward it, and a run
without a job records nulls.

## Hosts

- windows - the Job Object accounting

## Required

- [Gate run record](/quest/m0/gate-record.md) - the variable, the line
  format, and the Linux and macOS measurement this extends
