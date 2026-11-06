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
- Cover every Linux path a gated command takes. A gate nested inside a
  delegated Quest scope runs in a child cgroup of that scope (`nest`), and a
  child's weight competes only with its siblings, so the priority must apply
  where the enclosing scope meets the user manager's slices.
- Add `IOWeight` too only if the verification shows the session stalling on
  disk with CPU weight alone.
- The process-group owner (Linux without systemd, macOS) and Windows have no
  cgroup. Lower the command's priority there by each platform's equivalent,
  or say in the PR why a platform is left as is.
- Verify with two concurrent full gates of a large repository, before and
  after: the session's responsiveness under load (for example, scheduling
  latency of a probe in `session.slice` or `app.slice`), and each gate's
  wall time, solo and paired. Record the numbers in the PR.
