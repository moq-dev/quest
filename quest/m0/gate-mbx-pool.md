# [L] The gate admits work through mbx's pool when mbx is installed

## Goal

On a host with mbx installed, `quest gate` admits each command through
mbx's host-wide scheduler pool instead of its own load-average check, so
compiles, tests, and other heavy work across every worktree share one CPU
budget. Without mbx, the gate keeps today's load check. Work that barely
uses CPU, such as `quest review`'s model calls, and long-running servers
stay out of the gate.

Non-goals: making mbx a dependency of quest, and a mbx-specific command
such as `quest mbx`. mbx stays an optional backend the gate detects, in
the spirit of AGENTS.md's rule that the core not depend on a particular
repository, agent, or issue tracker.

## Plan

Found 2026-11-12 on the maintainer's 24-core host: load held at 28 to 32
for 15 minutes, CPU pressure at 42 to 52%, and up to 133 runnable threads,
while about 14 gated commands ran and more waited 8 to 25 minutes. Two
schedulers ignored each other:

- The gate holds a command while the 1-minute load exceeds the core count,
  counting running commands at their measured CPU peak
  ([moq-dev/quest#607](https://github.com/moq-dev/quest/pull/607)). It held
  cargo commands that mbx would have queued on its own.
- mbx already pools every compile on the host: a compile takes a permit
  sized to its thread count from one machine-wide budget
  (`scheduler.cpus` minus `scheduler.reserve_cpus`), and with
  `scheduler.tests` on, `cargo test` and `cargo nextest` binaries take
  permits too. Work outside cargo, such as interop runs that start real
  relays, Playwright's Chromium, Gradle, and gcc, escaped the pool.
- Agents also gated work that waits rather than computes: one
  `quest review` sat in the gate for over 25 minutes, and a server ending
  in `sleep infinity` held a gate scope that never exits.

Decided 2026-11-12 (maintainer, /quest-plan):

- What outcome? ✅ The gate defers to mbx when mbx is installed, and keeps
  its load check otherwise (rejected: a `quest mbx` command that runs cargo
  through mbx, which ties the core to one tool against AGENTS.md; nothing
  in quest, leaving each repository's justfile to call mbx).
- Should the gate also stop holding work that barely uses CPU? ✅ Yes, in
  this quest, since it is the same admission logic (rejected: a separate
  quest; leaving it to agents' judgment). `quest review` stops being
  gated. The shared rule in `assets/CONTEXT.md`, which today names
  builds, test suites, model checkers, and browsers as CPU-heavy, gains new
  text saying model calls and long-running servers stay out of the gate.
- How much does a gated command hold in mbx's pool? ✅ Its learned CPU
  peak minus what mbx's own compiles and tests inside it take (rejected: a
  `--cpus N` flag agents guess; a fixed one core, which lets non-cargo work
  escape the pool again).

How the reservation works, checked against mbx 1.30.0's source: a command
run inside `mbx reserve` has mbx scheduling switched off for everything it
starts (`crates/mbx/src/cli/reserve.rs` sets `MBX_SCHED_DISABLE=1`), so
nested compiles take no permits and the reservation alone covers them.
Running the command inside `mbx reserve` with only its non-mbx share would
oversubscribe the pool by the compiles it then runs unscheduled. So the gate
runs the command outside `mbx reserve`, where mbx keeps scheduling its
compiles and tests one by one, and holds a sidecar `mbx reserve --cpus <N>`
on a placeholder that lasts as long as the command, with N its non-mbx
share. This also avoids holding a whole build's cores through its idle
phases, the waste the load gate has today.

Agent's choices, for the implementer to revisit:

- The gate keeps no per-command history today: it measures a command only
  after admission and drops the entry a minute after it exits. Add a
  learned peak per command, keyed by its repository and argv, recording
  its total CPU peak and the part its mbx compiles and tests took, which
  are the processes running under mbx's compiler and test shims. With no
  history yet, reserve one core and record the run.
- Cap N at mbx's pool, `scheduler.cpus` minus `scheduler.reserve_cpus`,
  so a large non-mbx command never takes the cores mbx withholds for other
  work.
- Detect mbx from the command's working directory, so a workspace
  `.mbx.toml` that disables the scheduler counts. If mbx offers no way to
  read the effective workspace setting, ask jdx/mr-boxington for one, and
  until then treat a workspace that sets `scheduler.enabled = false` as
  having no mbx. Decide this once at the gate's start, never by retrying
  after `mbx reserve` fails.
- `QUEST_GATE_PRIORITY=1` keeps starting at once, as today. It takes no
  sidecar, and its compiles run at mbx's normal priority, for example
  through `MBX_SCHEDULER_PRIORITY`, so they jump ahead of agents'
  low-priority builds.
- `--quick` keeps its 60-second bound: if the sidecar is not granted by
  then, the command starts without one.
- The gate's memory budget stays as it is. mbx reserves only the
  resources it is asked for, and the sidecar asks for CPU only.
- Keep the gate's scope ownership, cancellation, and descendant cleanup;
  only admission changes.
- Measure it on cargo-heavy work, since quest's own `just check` runs no
  cargo: several moq-dev/moq `just check` or `just test` runs from
  separate worktrees at once, with and without mbx detected. Report wall
  time, load, and CPU pressure (`/proc/pressure/cpu`). Done when the mbx
  path keeps the host near its core count while finishing no slower than
  the load gate.
- Update `quest gate --help`, the README, and the shared rule above.

Installing mbx on the maintainer's host is outside this repository: the
maintainer directed it to kixelated/dotfiles on 2026-11-12, which already
links mbx's config. Until it lands, the measurement can use any mbx 1.30.0
or later on PATH.
