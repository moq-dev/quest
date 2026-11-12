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
- How much does a gated command hold in mbx's pool? ✅ Its full learned
  CPU peak, held by running the command inside `mbx reserve`, capped at
  mbx's pool (rejected: a `--cpus N` flag agents guess; a fixed one core,
  which lets non-cargo work escape the pool; no reservations, leaving
  non-cargo work outside the pool; asking jdx/mr-boxington for a lease its
  own nested compiles can draw from, which waits on upstream). The
  maintainer first picked the learned peak minus mbx's own share, and
  changed it at the review checkpoint: mbx switches its scheduling off
  inside `mbx reserve`, so that share had to be held by a sidecar beside the
  command, and three review rounds showed a sidecar can deadlock against
  its own command's later compiles or tests, which may each ask for the
  whole pool.

How the reservation works, checked against mbx 1.30.0's source: a command
run inside `mbx reserve` has mbx scheduling switched off for everything it
starts (`crates/mbx/src/cli/reserve.rs` sets `MBX_SCHED_DISABLE=1`), so
nested compiles take no permits and the reservation alone covers them,
which is how mbx avoids deadlocking a lease against its own work. The cost
is that a command holds its peak through its idle phases, much as the gate
already counts a running command at its measured peak
([moq-dev/quest#607](https://github.com/moq-dev/quest/pull/607)).

Agent's choices, for the implementer to revisit:

- The gate keeps no per-command history today: it measures a command only
  after admission and drops the entry a minute after it exits. Add a
  learned CPU peak per command, keyed by its repository and argv, from the
  scope measurement the gate already takes. With no history yet, reserve
  the whole pool, since a first cargo build inside the lease runs
  unscheduled and could otherwise fill the host.
- N is the learned peak, at least one core and at most mbx's pool,
  `scheduler.cpus` minus `scheduler.reserve_cpus`, so a command never takes
  the cores mbx withholds for other work. Since nothing inside the lease is
  scheduled, also bound the command's own parallelism to N, for example
  `CARGO_BUILD_JOBS` and nextest's thread count, so it cannot outgrow it.
- Ordinary reservations pass `--priority low`, since `mbx reserve`
  defaults to normal and ignores `scheduler.priority`.
- Detect mbx from the command's working directory, so a workspace
  `.mbx.toml` that disables the scheduler counts. If mbx offers no way to
  read the effective workspace setting, ask jdx/mr-boxington for one, and
  until then treat a workspace that sets `scheduler.enabled = false` as
  having no mbx. Decide this once at the gate's start, never by retrying
  after `mbx reserve` fails.
- `QUEST_GATE_PRIORITY=1` keeps starting at once, as today. It runs
  outside `mbx reserve`, so mbx schedules its compiles one by one, at mbx's
  normal priority, for example through `MBX_SCHEDULER_PRIORITY`, so they
  jump ahead of agents' low-priority builds.
- `--quick` keeps its 60-second bound: if the reservation is not granted
  by then, the command starts outside it, where mbx still schedules its
  compiles.
- The gate's memory budget stays as it is. mbx reserves only the
  resources it is asked for, and the gate asks for CPU only.
- Keep the gate's scope ownership, cancellation, and descendant cleanup;
  only admission changes.
- Measure it on cargo-heavy work, since quest's own `just check` runs no
  cargo: several moq-dev/moq `just check` or `just test` runs from
  separate worktrees at once, with and without mbx detected. Report wall
  time, load, and CPU pressure (`/proc/pressure/cpu`). Done when, on the
  mbx path, gated work stays near mbx's pool (`scheduler.cpus` minus
  `scheduler.reserve_cpus`, 18 of 24 cores on the maintainer's host), CPU
  pressure falls below the load gate's, and the runs finish no slower and
  never deadlock.
- Update `quest gate --help`, the README, and the shared rule above.

Installing mbx on the maintainer's host is outside this repository: the
maintainer directed it to kixelated/dotfiles on 2026-11-12, which already
links mbx's config. Until it lands, the measurement can use any mbx 1.30.0
or later on PATH.
