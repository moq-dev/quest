# [L] Enable free cloud runners with one click

## Goal

A maintainer enables cloud runners for a project with one click. kix starts
the runner in a hosted container when routed work needs it and stops it when
idle. Jobs run with the maintainer's connected API keys, and the operator's
spend cap bounds the free hosting.

## Plan

- Use Cloudflare Sandbox as the initial adapter: a Linux image with Nix, the
  runner, and its pinned CLIs. Workers isolates cannot run them. Verify
  container lifetime, cancellation, and filesystem/session persistence
  rather than assuming a process keeps a sandbox alive.
- Keep provider keys out of the container. A constrained credential proxy
  forwards each job's requests to the chosen key; the container gets a
  revocable job credential only.
- Decided 2026-10-15 in the funding interview: the first cloud release uses
  maintainer API keys. Enable production key collection with this hosted
  integration; [donor allocations](/quest/m2/cloud/donors.md) follow working
  cloud runners and do not gate this quest.
- Reuse the project's Nix devShell and the shared cache where available, so
  cold containers do not rebuild the world.
- The operator cap stops new cloud starts when reached and says so plainly;
  routing falls back to the maintainer's own runners, never to a different
  payer.
- Supply a clean per-process environment. Keep secrets outside project
  setup/build processes.
- Sources:
  [Cloudflare Claude example](https://developers.cloudflare.com/sandbox/coding-agents/claude-code/),
  and [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/).

## Required

- [API funding](/quest/m2/cloud/funding.md) - maintainer API keys, the credential proxy, and accounting
