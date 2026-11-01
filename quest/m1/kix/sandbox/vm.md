# [L] Build untrusted PR devShells in a VM

## Goal

A Linux runner registered with `vm: true` accepts untrusted PR heads: it
evaluates and builds the PR's own devShell in a per-job KVM microVM, brings
the closure into the host store, and runs the job's commands in the OS
sandbox with no network.

## Plan

- Decided 2026-10-15: a VM per untrusted build, not per job; the commands
  still run in the OS sandbox afterwards.
- Verify how to import unsigned store paths without making the runner trust
  arbitrary builders, and never publish them to the
  [shared cache](/quest/m2/automation/cache.md).
- The runner refuses untrusted jobs until this ships;
  the trusted-head classifier routes untrusted heads here.
- Test a PR whose flake or shellHook tries to run on the host, and one whose
  build tries to reach the network.
