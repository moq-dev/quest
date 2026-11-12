# [L] The gate admits work through mbx's pool when mbx is installed

## Goal

On a host with mbx installed, `quest gate` admits each command through
mbx's host-wide scheduler pool instead of its own load-average check, so
compiles, tests, and other heavy work across every worktree share one CPU
budget. Without mbx, the gate keeps today's load check. Work that barely
uses CPU, such as `quest review`'s model calls, and long-running servers
stay out of the gate.

Non-goals: making mbx a dependency of quest, and a mbx-specific command
such as `quest mbx`. The core stays independent of any one tool, as
AGENTS.md requires; mbx is an optional backend the gate detects.

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
  gated, and the guide says long-running servers stay out of the gate.
- How much does a gated command hold in mbx's pool? ✅ Its learned CPU
  peak, which the gate already measures, minus what mbx's own compiles and
  tests inside it take (rejected: a `--cpus N` flag agents guess; a fixed
  one core, which lets non-cargo work escape the pool again).

Agent's choices, for the implementer to revisit:

- Detect mbx at the gate's start: an `mbx` on PATH whose
  `scheduler.enabled` is true. Admit through `mbx reserve --cpus <N>`,
  with N the learned peak net of mbx-charged work and at least one core.
  Keep `QUEST_GATE_PRIORITY=1`'s meaning by passing `--priority normal`
  for it and `low` otherwise, matching how mbx yields a quarter of its pool
  to normal-priority builds.
- First establish how mbx charges a compile started inside an
  `mbx reserve`: against the reservation, or again on top of it. mbx's
  docs describe `reserve` only for work outside mbx. If nested compiles
  are charged twice, a large reservation for `just check` double-counts
  them; then ask jdx/mr-boxington for nested reservations (the binary
  already carries an `MBX_RESERVE_WORKER` variable), and until it lands,
  reserve one core for commands whose learned peak is mostly mbx work.
- Keep the gate's own scope ownership, cancellation, and descendant
  cleanup as they are; only admission changes.
- Measure it: run several `just check`s from separate worktrees at once,
  with and without mbx detected, and report wall time, load, and CPU
  pressure (`/proc/pressure/cpu`). Done when the mbx path keeps the host
  near its core count while finishing no slower than the load gate.
- Update `quest gate --help`, the README, and the shared rule that tells
  agents what to gate, which names model calls and servers as not
  CPU-heavy.

Host setup, such as installing mbx and its config, is planned in the
maintainer's dotfiles, not here.
