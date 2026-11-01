# [L] Isolate untrusted local donor jobs

## Goal

Local donors can run projects they do not trust in a supported VM boundary
with constrained network and filesystem access, without exposing host secrets.

## Plan

- m0 [sandboxes](/quest/m0/kix/sandbox/README.md) job commands at the OS level and
  builds untrusted devShells in a VM. This quest adds a stronger whole-job
  boundary for shared runners running other people's projects. Nix devShells
  give reproducibility, not an isolation boundary for arbitrary commands.
- Evaluate current microVM tooling and supported Linux/macOS hosts before
  selecting an adapter. Do not make a beta runtime a core requirement.
- Keep provider keys and publication credentials outside guests, and enforce
  per-job authorization and egress. Document residual risks and unsupported hosts.
- Verify filesystem, network, credential, teardown, and interrupted-job boundaries.

## Required

- [Shared runners](/quest/m2/donor-runner.md) - the execution path this hardens
