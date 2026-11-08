# Cloud runners

## Goal

A maintainer clicks one button to add cloud runners alongside their own
machines. Cloud runners are the same runner in a hosted container, using
connected API keys or donor allocations, and look like any other runner in
routing and the UI.

## Plan

Decided 2026-10-15 in the decisions-not-implementations interview:

- Cloud runners follow the m0 own-machine runners and reuse the same runner,
  job protocol, Nix devShell requirement, sandbox, and adapters. They are
  Linux-only.
- Start with free cloud compute: the operator pays hosting under a spend
  cap. Paid compute comes later in its own quest, once usage justifies it.
- Hosted runners use API keys only. Provider terms make hosted subscription
  use conditional (Claude) or high-risk (Google), so subscriptions stay on
  the user's own machines.
- Decided 2026-10-15 in the funding interview: finish the m0 runner,
  sandbox, and opencode adapter before maintainer API funding, then integrate
  hosted runners. Donor allocations follow working maintainer-funded cloud
  runners. This order removes the ambiguous requirement that funding wait
  for the cloud runners that depend on it.
- Funding setup and operating guidance stay in existing service
  documentation; each implementation updates the docs it changes.
