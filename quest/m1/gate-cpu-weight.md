# [S] Gate scopes yield the CPU to the interactive session

## Goal

`quest gate` keeps concurrent expensive commands from starving the
interactive desktop session. Today two full gates of a large repository
(`just check` plus `just test`, about 2,600 CPU-s each) started together on a
24-core desktop hold host load at 62.9 and CPU pressure (PSI some) at 80.6%
for about 150 s, saturating the desktop. With this quest, the same
pair still runs to completion, but the session's own processes keep CPU
priority over gated work. Admission is unchanged: this quest changes where
admitted commands run, not when they are admitted.

## Plan

Decided 2026-11-06 (maintainer, /quest-complete follow-up):

- How should a gate keep the session responsive?
  - ✅ Lower the gated command's CPU weight (recommended)
  - Charge admission by each command's measured cores
  - Both

  Admission math stays as it is; a weight change works on contention as it
  happens, while admission decides from the 1-minute load average.

Today, on Linux with a systemd user manager, `scope` in `src/cli/gate.ts`
calls `systemdScopes.run` in `src/cli/supervise.ts`, whose `systemd-run
--user --scope` names no slice or weight. Each gate scope therefore lands in
`app.slice` at the default `CPUWeight=100`, a sibling of the desktop's
applications, and `app.slice` weighs the same as `session.slice`, which holds
the GNOME session. systemd's user manager also ships `background.slice` at
`CPUWeight=30` for exactly this kind of work. Checked on 2026-11-06 with
`systemctl --user show <unit> -p Slice,CPUWeight` against running gate
scopes.

- Run gate-admitted commands in `background.slice`, or at a low `CPUWeight`,
  so the session keeps priority. Weight only matters under contention, so a
  lone gate on an idle host should keep its wall time.
- Cover every Linux path a gated command takes, and lower only the gated
  command, never the Quest scope around it. `quest worktree run` can hold a
  whole agent session, so moving its scope into `background.slice` or
  reweighting it would slow the session's non-gated work too.
- A gate inside a delegated Quest scope runs its command in a child cgroup of
  that scope (`nest`). A lower weight there would not help the desktop. A
  child's weight competes only with its siblings, so the gated command would
  still take the whole scope's share against the desktop. cgroup v2 also lets
  the scope give its children a CPU weight only once no process sits in the
  scope's own cgroup, where the session runs.
- So the likely shape is a sibling scope. The gate runs its command in a scope
  of its own in `background.slice`, as an unnested gate does, bound to the
  enclosing scope with `BindsTo=` and `KillSignal=SIGKILL`, as
  `systemdScopes.run` already binds a scope inside another. The enclosing
  scope keeps its slice and weight, so the session's own work keeps its
  priority and only the gated command yields. The same applies to a gate in a
  Quest scope that predates delegation, which today runs its command in the
  scope itself (`inside`).
- Leaving the enclosing cgroup gives up what `nest` relies on: the enclosing
  scope's `cgroup.kill`, and its owner's signal to every process in it. The
  implementation must show that stopping the enclosing run, its liveness check
  in `worktree.ts`, and a forwarded signal still reach the gated command. If
  that cannot hold, pick another shape and say why in the PR.
- Add `IOWeight` too only if the verification shows the session stalling on
  disk with CPU weight alone.
- The process-group owner (Linux without systemd, macOS) and Windows have no
  cgroup. Lower the command's priority there by each platform's equivalent,
  or say in the PR why a platform is left as is.
- Verify with two concurrent full gates of a large repository, before and
  after: the session's responsiveness under load (for example, scheduling
  latency of a probe in `session.slice` or `app.slice`), and each gate's
  wall time, solo and paired. Record the numbers in the PR.
