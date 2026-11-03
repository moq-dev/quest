# [M] Guide maintainers through Kix

## Goal

A dedicated guide takes a maintainer from project enrollment and runner
setup through an issue's planning interview, an implementation, and a
reviewed GitHub PR, answering decisions from their phone, without guessing
how the service works.

## Plan

- User chose a separate end-to-end guide on 2026-10-13. Individual features
  still update any existing documentation they make stale.
- Keep the product path centered on decisions and prompts. Explain
  repository opt-in, Quest-file requirements, GitHub App permissions, who
  can answer, and how draft plans become eligible after merging.
- Decided 2026-10-15: cover installing `quest runner` on Linux or macOS, the
  required Nix devShell (and adding one), signing in multiple Claude Code and
  opencode accounts, routing and pinning, account limits, and what happens
  when a runner goes offline. Cover installing the PWA and enabling push
  notifications, including adding it to the iOS home screen.
- Cite current official provider terms for using subscriptions with each
  CLI, and say plainly that kix never holds provider tokens.
- Include operator registration and recovery in an
  operator section. Keep those details out of the maintainer's normal
  decision flow.
- Extend the guide when cloud runners, API-key funding, and donations ship;
  do not advertise them as available before then.
- Validate the guide against the running UI and a real pilot repository.

## Required

- [Web execution](/quest/m0/kix/execution.md) - the complete user flow being documented
- [Operator setup](/quest/m0/kix/operator-setup.md) - verified deployment and App setup
