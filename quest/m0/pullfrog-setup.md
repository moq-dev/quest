# [S] Pullfrog reviews run in the dev shell

## Goal

Pullfrog's review runs in a moq-dev repository that needs its dev shell, such
as moq-dev/rind, whose tests need the vectors `./.github/actions/vectors`
fetches, have Nix, the repository's dev shell, `quest`, and `just` before the
agent starts, so the bot can run the repository's checks and tests instead of
reasoning around their absence.

## Plan

Decided 2026-11-12 (user, /quest-plan): ✅ both a reference-line fallback
([no-cli-context](/quest/m0/no-cli-context.md)) and a setup step here
(rejected: only the fallback; only this setup step).

Evidence from the trimmed Pullfrog learnings: rind's bot cannot fetch its
test vectors because `.git` is read-only, so about 20 tests fail and six
learnings existed only to work around it; studio, rust2, quest, and
web-transport each recorded a missing `quest`, `nix`, or `just`.

Open for the implementer, with recommendations:

- Where the step runs. Pullfrog's per-repository `hooks.setup` setting
  (`pullfrog config set hooks.setup ... --repo moq-dev/<repo>`) or steps
  before the action in `.github/workflows/pullfrog.yml`, whose header says to
  edit only where indicated. Recommended: `hooks.setup` if it runs with the
  privileges a Nix install needs; check Pullfrog's docs and one run's log.
- Which repositories. Measure the added setup time on one run; recommended:
  every repository whose reviews would run its tests (rind first), and none
  where the fallback alone covers what reviews need.
