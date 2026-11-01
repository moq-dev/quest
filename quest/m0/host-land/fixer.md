# [S] Connect the host fixer to CLIProxyAPI

## Goal

The nixos fixer container reaches CLIProxyAPI with the gate's client key, while
Codex login and Git/GitHub credentials stay outside the container. Verify a real
mechanical fix and unchanged requeue through the host daemon.

## Plan

Maintainer decision, 2026-10-30: a `fixed` head lands without further review.
"Mechanical" stays prompt-enforced, protected paths are blocked, and the residual
prompt-injection risk is accepted. Superseded 2026-11-01 (user): the fixer edits
protected paths it judges mechanical; see [Protected edits](/quest/m0/land-fixer/protected.md). The built-in prompt treats contributor content
as untrusted and hands back attempts to redirect its task.

- Claude reviews the fix first
- Fixes need a re-pick
- Narrow what it may touch
- ✅ Keep as decided

The quest CLI implements `quest land fix`, durable collection, validation,
lease-pushes, Review records, and one attempt per maintainer pick. Host work
remains in kixelated/nixos: allow the ephemeral fixer container network access
only to CLIProxyAPI, provide `OPENAI_BASE_URL` and the gate's `OPENAI_API_KEY`,
and log the maintainer's Codex account into CLIProxyAPI. The wrapper runs with
the supplied repository as cwd, receives `<log> <PR numbers...>`, exposes the
log read-only, waits for `quest land fix`, preserves its exit status, and returns
`quest-land-result.json` in the repository. See the README's landing contract.

## Related

- [Gate host](/quest/m0/host-land/host.md) - container provisioning and daemon rollout
