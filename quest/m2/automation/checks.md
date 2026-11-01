# [L] Donate repository check capacity

## Goal

A project can authorize donated runners to execute its own checks against
a pinned revision and publish accurately attributed GitHub check results.

## Plan

- Run checks inside the project's Nix devShell, like every runner job
  (decided 2026-10-15, replacing repository-defined tools). Define runner trust and which results can satisfy protections before enabling
  authoritative checks; untrusted reports remain advisory.
- Run untrusted code apart from signing and publication credentials.
  Keep GitHub's native checks and existing CI authoritative.
- Share claims, cancellation, progress, and artifact/result handling.
  Never execute fork code in a privileged publisher.
- Test forged reports, changed heads, interrupted jobs, and duplicate events.

## Required

- [Shared runners](/quest/m2/donor-runner.md) - contributed execution capacity
