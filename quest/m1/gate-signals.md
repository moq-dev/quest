# [M] Cancelling a gate stops its active phase

## Goal

SIGTERM or SIGHUP sent to `quest gate` stops the command's active phase
promptly, even when Just, a Bash script that traps the signal, and GNU `time`
sit between the gate and the phase. Each process the gate owns gets the
signal and can run its own cleanup before the gate stops whatever is left.
This holds for the systemd scope and the process-group owners. A second
signal still kills everything at once.

## Plan

Decided 2026-11-02 (maintainer, `/quest-unblock` in moq-dev/moq.pro): fix
this upstream, in m1. It blocks
[moq-dev/moq.pro#3137](https://github.com/moq-dev/moq.pro/pull/3137), which
puts its expensive `just check` and stack phases behind the gate and keeps a
draft until cancellation works. The quest it follows is
`quest/m0/test-footprint/local-gate.md` on that PR's branch. There the root
check runs `exec quest gate -- bash check.sh` and traps TERM and HUP. Each
phase runs under GNU `time`. A blocked Node phase kept running until a
fixture stopped it, and only then did the check return 143.

Reproduced on main (`a2a7efc`) with both owners. Each run gated
`bash -c 'trap "exit 143" TERM; …'` around a leaf that runs for 6 s and
records whether its own TERM handler ran:

| Inner layers | Gate returns after TERM | Leaf's handler runs |
| --- | --- | --- |
| Bash trap, leaf in the foreground | 6.0 s | no |
| Bash trap, GNU `time` in the foreground | 6.0 s | no |
| Bash trap that kills `$!` and waits (no `time`) | 0.0 s | yes |
| Same, with GNU `time` as `$!` | 0.0 s | no: `time` dies on TERM without forwarding it, and the gate SIGKILLs the leaf |
| TERM sent to the whole process group (candidate fix), with or without `time` | 0.0 s | yes |

- Cause: `group` and `systemdScopes.run` (`src/cli/gate.ts`,
  `src/cli/supervise.ts`) deliver SIGTERM and SIGHUP to the command alone, and
  only SIGINT reaches the whole group. Bash runs a trap only after its
  foreground command ends, and GNU `time` does not forward the signal.
- Direction: deliver SIGTERM and SIGHUP to everything the gate owns, as a
  terminal's Ctrl-C already reaches the group. That means `process.kill(-pgid)`
  for the group owner, and the whole scope for the scope owner (for example
  `systemctl --user kill --kill-whom=all --signal=…`, which is how systemd's
  default `KillMode=control-group` stops a unit). Do not use PID traversal,
  polling, or a timeout.
- `quest worktree run` uses the same `systemdScopes.run`. Decide whether it
  changes the same way. Recommended: yes, so that one supervisor has one set
  of signal semantics.
- Avoid delivering the same signal twice. A nested Quest process that gets
  the signal twice treats the second as a kill. Today `forwards`
  (`src/cli/interrupt.ts`) holds back only SIGINT, and only under the group
  owner's `GROUP` marker or a foreground terminal. Nothing marks a scope:
  `systemdScopes.run` passes the environment through, and a gate nested in a
  scope runs `direct` (`owner` in `src/cli/gate.ts`), which forwards TERM and
  HUP every time. Hold back SIGINT, SIGTERM, and SIGHUP whenever the owner
  that signals everything it holds also holds the child:
  - Group owner: extend the `GROUP` rule to TERM and HUP. A gated command
    stays in the group, so the marker stays accurate: a nested gate runs
    `direct`, and `systemdScopes.run` changes the cgroup but not the
    process group.
  - Scope owner: hold back in `direct` while `scoped()` reports a Quest scope.
    The child shares that cgroup, so the scope-wide signal already reached
    it. Do not use an inherited env marker for this. A `quest worktree run`
    nested in a gate scope calls `systemdScopes.run`, whose command moves to
    a new sibling scope outside the enclosing scope. That command needs the
    forwarded signal, so `systemdScopes.run` keeps forwarding unless `GROUP`
    applies.
  - `scoped()` matches every `quest-*.scope`, `quest worktree run`'s
    included. So this rule needs every Quest scope owner to signal the whole
    scope, which is one more reason to change `quest worktree run` too.
  - Trade-off, as for SIGINT today: TERM or HUP sent with `kill` to a nested
    Quest alone is not forwarded, so its command stops only at the second
    signal. Document this beside `forwards`.
- Ordering: once the command exits, the gate SIGKILLs the rest at once. If
  `time` and Bash exit before the leaf finishes its own cleanup, that cleanup
  is cut short. This matters most for a leaf that stops children it detached
  into their own groups. Under the group owner those children are outside
  the gate's reach, as in moq.pro's `dev/smoke.ts` and `e2e/src/perf/fixture.ts`.
  Settle whether a cancelled run gives what remains time to drain until the
  second signal arrives, using an event rather than a poll. The scope's
  `vacated` already waits on `cgroup.events`. Or record that a phase which
  detaches children must outlive its wrappers.
- Tests: real `just` → Bash with traps → GNU `time` → leaf fixtures,
  synchronized on events, for both owners (`test/gate.test.ts` already runs
  each owner directly). Cover TERM, HUP, and the second-signal
  kill. For each owner, add nested-gate tests for TERM and HUP that check the
  leaf gets each signal exactly once and that the command is not killed. This
  extends the SIGINT case "delivers SIGINT once to a command under a nested
  gate". Also test that a `quest worktree run` nested in a gate scope still
  forwards to its own scope. Add GNU `time` to the devshell if the fixture needs it. Update the
  gate's section of the README.
- Adoption in moq.pro bumps its `quest` flake input past this fix. That
  belongs to #3137, not to this quest.

## Related

- [Own gated descendants everywhere](/quest/m2/gate-ownership.md) - delegated sub-cgroups and Windows Job Objects for the same owners
