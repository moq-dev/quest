# [S] Pullfrog reviews run in the dev shell

## Goal

Before the agent starts, Pullfrog's review run has Nix, the repository's dev
shell, `quest`, `just`, and whatever files the repository's tests read, in each
moq-dev repository whose reviews need its dev shell, such as moq-dev/rind. The
bot then runs the repository's checks and tests instead of reasoning around
their absence.

## Plan

Decided 2026-11-12 (user, /quest-plan): ✅ both a reference-line fallback to
the rules on GitHub, now in `quest init`, and a setup step here
(rejected: only the fallback; only this setup step).

Pullfrog reviews with Claude since 2026-11-12, its model access configured in
the Pullfrog console, and its workflow is back in moq-dev/quest (#659),
moq-dev/rind, moq-dev/rust2, moq-dev/studio, and moq-dev/web-transport after
the 2026-11-10 removal [token-waste](/quest/m0/token-waste/README.md) records.

Evidence from the trimmed Pullfrog learnings: rind's bot cannot fetch its
test vectors because `.git` is read-only, so about 20 tests fail and six
learnings existed only to work around it; studio, rust2, quest, and
web-transport each recorded a missing `quest`, `nix`, or `just`.

Rind's vectors are the `thirdparty/cavp`, `thirdparty/cctv`, and
`thirdparty/wycheproof` submodules its `./.github/actions/vectors` action
initializes. Nix and the dev shell do not make `.git` writable, so the setup
step also initializes them before the agent starts, or the dev shell provides
them as a Nix input; either way rind's `just test` passes in the review run.

Trust boundary: the run holds `id-token: write` to mint the token Pullfrog
trades for model access, and `assets/CONTEXT.md` forbids running code from a
PR whose author lacks write access. Recommended: on such a PR the setup step
enters the dev shell from the default branch's checkout, and the bot runs no
checks or tests from the PR's head; confirm how Pullfrog checks out a fork
PR's head and that the agent's instructions say so.

Open for the implementer, with recommendations:

- Where the step runs. Pullfrog's per-repository `hooks.setup` setting
  (`pullfrog config set hooks.setup ... --repo moq-dev/<repo>`) or steps
  before the action in `.github/workflows/pullfrog.yml`, whose header says to
  edit only where indicated. Recommended: `hooks.setup` if it runs with the
  privileges a Nix install and a submodule fetch need; check Pullfrog's docs
  and one run's log.
- Which repositories. Measure the added setup time on one run; recommended:
  every repository whose reviews would run its tests (rind first), and none
  where the fallback alone covers what reviews need.
