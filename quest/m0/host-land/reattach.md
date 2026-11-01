# [M] A restarted land daemon keeps its in-flight check

## Goal

Restarting `quest land serve`, as every host deploy does, never discards a
running batch check. The new daemon picks up the check the old one started
and lands, ejects, or hands back from its result, so a deploy costs no
rerun of a 30-40 minute batch.

## Plan

Decided 2026-10-31 (user, /quest-plan of the follow-ups from moq.pro's and rust2's cutover to the host gate and the fixer repairs [moq-dev/quest#320](https://github.com/moq-dev/quest/pull/320), [#325](https://github.com/moq-dev/quest/pull/325), [#327](https://github.com/moq-dev/quest/pull/327) and [#328](https://github.com/moq-dev/quest/pull/328)).

- On 2026-10-31 each of six deploys killed moq's and moq.pro's in-flight
  checks: the check client is the daemon's child, and with
  `KillMode=process` it still exits on its next write to the dead daemon's
  pipe. No PR was ejected, but each batch reran from scratch.
- Fixers already survive this way: a detached supervisor records the job and
  the next daemon collects it (`src/cli/land-fixer.ts`). Give a batch check
  the same shape: a detached client that writes its log and exit status to
  the state directory, and a daemon that resumes a recorded batch on start
  instead of building a new one.
- The host side (the check launcher, `KillMode=process`) is the
  [gate host](/quest/m0/host-land/host.md)'s.

## Related

- [Gate host](/quest/m0/host-land/host.md) - the units this runs under
