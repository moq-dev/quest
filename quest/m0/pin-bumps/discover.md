# [S] The bump pass finds its own targets

## Goal

`quest land watch` bumps every repository its App is installed on whose
`flake.lock` locks the watched repository through exactly one root input, with no list of
repositories on the host: installing moq-bot on a repository enrolls it, and
uninstalling it stops its bumps.

## Plan

Decided 2026-11-12 (maintainer, /quest-plan; see the
[epic](/quest/m0/pin-bumps/README.md)): ✅ discover the targets (rejected:
`--bump <owner/repo>` flags in the host's configuration, which went stale).
Replace the repeatable `--bump <owner/repo>` with one switch; nothing is in
production, so drop the list form.

A pass lists the App's installations and their repositories, reads each
default branch's `flake.lock`, and treats the repositories that lock the
watched repository through exactly one root input as targets, which is what
the bump needs (`questInput` in `src/cli/land-bump.ts`). Skip the watched repository itself. Rereading
every repository each pass costs API quota: keep it to what a pass needs, such
as only when the base moved.

Tests against a fake GitHub: a repository that locks quest is bumped, one
that doesn't is never cloned, and one dropped from the installation is not
bumped again.
