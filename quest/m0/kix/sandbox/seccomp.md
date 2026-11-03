# [S] opencode jobs' commands can't reach Unix sockets

## Goal

The sandbox-runtime (srt) that runs opencode jobs' commands applies its
seccomp filter, so a sandboxed command cannot connect to any Unix socket,
the Nix daemon's included. The runner refuses to start an opencode job when
srt reports Unix-socket blocking disabled, and the boundary test probes the
daemon socket, so a package bump that drops the filter fails CI. srt's
always-writable `/tmp/claude` is denied too.

## Plan

Decided 2026-11-02 (coordinator, /quest-spawn follow-ups, after the user
asked the coordinator to decide follow-ups from evidence): plan it, [S],
first in this epic, since it is a hole in a boundary the README says holds.

Evidence, gathered 2026-11-02:

- nixpkgs' `sandbox-runtime-0.0.81`, which `flake.nix` uses as is, ships
  `vendor/seccomp/build.ts` but no compiled `apply-seccomp` helper. srt then
  logs `apply-seccomp binary not available - unix socket blocking disabled`
  (seen in [moq-dev/quest#435](https://github.com/moq-dev/quest/pull/435)'s
  session on 2026-11-03T03:55Z).
- Run with the runner's `runtimeSettings` shape (reads of `/home` and `/tmp`
  denied), `nix store ping --store daemon` inside srt answered
  `Version: 2.35.2`. `nix config show trusted-users` is
  `root kixelated github-runner`, so a job's command on this host could pass
  the daemon root-level options. This contradicts the epic's "Commands have
  no Nix daemon". No runner was deployed on the host yet.
- [moq-dev/quest#404](https://github.com/moq-dev/quest/pull/404)'s boundary
  test passed because it probes no Unix socket.
- srt 0.0.81 lists `/tmp/claude` in `SANDBOX_OWN_WRITE_PATHS`, which it never
  drops (`dist/sandbox/sandbox-utils.js`). The directory doesn't exist on
  this host and a sandboxed `mkdir` lands on srt's private tmpfs, so it
  matters only if something on the host creates it. Deny it anyway while
  editing the same settings.

Work:

- Build `apply-seccomp` for the flake's `sandbox-runtime` (an override that
  compiles it per `build.ts` against static libseccomp), or package the npm
  tarball's prebuilt helper and pass `seccomp.applyPath`. Prefer the build
  from source, matching how the flake pins the rest.
- The runner refuses an opencode account when srt reports Unix-socket
  blocking disabled, with an error that names the missing helper.
- Add to the boundary test: connecting to the Nix daemon socket, and to a
  socket the test opens outside the sandbox, are both refused.
- Add `/tmp/claude` to `denyWrite` if srt honours it over its own write
  paths without leaving a placeholder behind; otherwise record why not.
