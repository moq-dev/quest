# [M] The gate's run record on Windows

## Goal

On Windows, `QUEST_GATE_RECORD` works as it does on Linux and macOS: each
outermost `quest gate` run appends one line, with CPU time and peak
memory taken from the Job Object that owns the command and everything it
starts.

## Plan

Decided 2026-11-12 (maintainer, `/quest-plan`): split from the gate run
record, since m0 leaves native Windows and its suite to m1. The README's
"Record each run" section gives the variable and the line format; until
this lands, `quest gate` on Windows refuses `QUEST_GATE_RECORD`.

The Job Object lives in the Bun stub that `src/cli/job.ts` runs, and it
ends with the stub, so the gate never holds it. The stub reads the job's
basic accounting (total user and kernel time) and its peak job memory
once the command exits, before it closes the handle, and passes them to
the gate over a channel of its own, such as an extra pipe, keeping the
command's stdio untouched. Its line's `measured` is `job`, since the
job covers everything the command started. Without a job, which the stub
only warns about today, the line carries `children` from the stub's own
child, as on a process group.

Tests, in the native Windows suite: a stub command's line carries its
CPU and peak memory, a grandchild's CPU counts toward it, and a run
without a job is labeled `children`.

## Hosts

- windows - the Job Object accounting
