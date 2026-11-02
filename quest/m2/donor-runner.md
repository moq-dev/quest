# [L] Share your runner with other projects

## Goal

A contributor offers their runner and selected accounts to opted-in
projects they don't maintain, with explicit capacity limits. Shared jobs
route to it like any other runner and return results for trusted bot
publication.

## Plan

- Decided 2026-10-15: the m0 runner replaces the API-worker CLI, API
  workflow skills, and Claude Code plugin. Sharing reuses that runner,
  rather than a separate daemon.
- Explicitly select projects, accounts, and capacity. Honor project pauses
  and the contributor's revocation, and preserve interrupted results
  without duplicate jobs.
- Provider terms bar sharing a subscription account; check each provider's
  current terms before letting a subscription account serve other people's
  projects, and default shared capacity to API-key accounts.
- Keep GitHub credentials off the runner. Never trust its claims about
  successful checks as authority to merge.
- Support trusted projects first with an explicit local trust boundary.
  Stronger untrusted-project isolation is a separate quest.
- Test registration, stale leases, reconnect, cancellation, and publication
  rejection for mismatched repository/revision.
