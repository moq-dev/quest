# [S] Pullfrog reviews have what their checks need

## Goal

Before the agent starts, Pullfrog's review run has what the repository's
checks and tests need, such as Nix, the dev shell, `quest`, and `just`, in
each repository whose Pullfrog reviews would run them. The bot then runs the
repository's checks and tests instead of reasoning around their absence.

## Plan

Decided 2026-11-12 (user, /quest-plan): ✅ both a reference-line fallback
([no-cli-context](/quest/m0/no-cli-context.md)) and a setup step here
(rejected: only the fallback; only this setup step).

Pullfrog reviews with Claude since 2026-11-12, its model access configured in
the Pullfrog console, and its workflow is back in moq-dev/quest (#659),
kixel-ai/rind, moq-dev/rust2, moq-dev/studio, and moq-dev/web-transport after
the 2026-11-10 removal [token-waste](/quest/m0/token-waste/README.md) records.

Evidence from the trimmed Pullfrog learnings: rind's bot could not fetch its
test vector submodules because `.git` is read-only, so about 20 tests failed;
studio, rust2, quest, and web-transport each recorded a missing `quest`,
`nix`, or `just`.

Decided 2026-11-12 (user, iterating
[kixel-ai/rind#714](https://github.com/kixel-ai/rind/pull/714)): ✅ files a
repository's tests read are checked in, so a plain clone runs every test
(rejected: fetching them in a Pullfrog setup step on every run; pinning them
as Nix flake inputs, which still needs Nix in the reviewer). That PR copies
the Wycheproof, CAVP, and CCTV files its tests open into `thirdparty/vectors/`
with `admin/sync-vectors`, and rind's Pullfrog workflow gets no setup step:
`ubuntu-latest` already has cargo, and vectors were its only recorded
problem. Until that PR merges, rind's `main` still has the submodules.

Remaining:

- Rind: once its PR merges, dispatch one Pullfrog run that runs rind's
  tests (`gh workflow run pullfrog.yml -R kixel-ai/rind -f prompt='Run cargo
  test --workspace on main and report any failure'`; the workflow takes its
  task only from `prompt`) and check its log for passing tests. Rind is done when that run passes, and needs this quest's
  setup work only if it shows another gap.
- Studio, rust2, quest, and web-transport, whose gaps are tools, not
  files. Prefer making the bot need no tool it lacks, as rind did, over
  installing one. Where a repository's checks still need Nix or `just`, add
  only that.

Trust boundary: the run holds `id-token: write` to mint the token Pullfrog
trades for model access, and `assets/CONTEXT.md` forbids running code from a
PR whose author lacks write access. Recommended: on such a PR the setup step
enters the dev shell from the default branch's checkout, and the bot runs no
checks or tests from the PR's head; confirm how Pullfrog checks out a fork
PR's head and that the agent's instructions say so.

Token exposure: `DeterminateSystems/nix-installer-action` writes the job's
`GITHUB_TOKEN` into the world-readable `/etc/nix/nix.conf` as
`access-tokens`, where the agent's shell can read it, as Pullfrog's review of
[kixel-ai/rind#714](https://github.com/kixel-ai/rind/pull/714)'s first
approach found. A setup step that installs Nix must delete that line before
the agent starts, whether or not it builds a dev shell.

Open for the implementer, with recommendations:

- Where the step runs. Pullfrog's per-repository `hooks.setup` setting
  (`pullfrog config set hooks.setup ... --repo <owner>/<repo>`) or steps
  before the action in `.github/workflows/pullfrog.yml`, whose header says to
  edit only where indicated. Recommended: workflow steps, since the Pullfrog
  CLI could not read a repository's settings without the maintainer's login;
  `hooks.setup` if that changes and it has the privileges a Nix install needs.
- Which repositories. Measure the added setup time on one run; recommended:
  every repository whose reviews would run its tests, and none where the
  fallback alone covers what reviews need.

## Waiting

- kixel-ai/rind: merge [kixel-ai/rind#714](https://github.com/kixel-ai/rind/pull/714),
  which vendors rind's test vectors; check that rind's `main` has
  `thirdparty/vectors/{wycheproof,cavp,cctv}/` and none of those three
  submodules. The review run the Plan's Remaining list names follows it.
