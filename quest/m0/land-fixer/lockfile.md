# [S] The fixer rebuilds a conflicted lockfile from the base's copy

## Goal

When the fixer resolves a lockfile while merging the base (`bun.lock`,
`Cargo.lock`, `uv.lock`, `go.sum`, and the like), it starts
from the base's copy and runs the package manager, so the result adds only
the PR's own dependency changes. A fixer merge never reverts a dependency
change the base made, such as a security bump.

Non-goals: running `bun audit` or another advisory scan in a repository's
land check; that is each repository's CI choice.

## Plan

Decided 2026-11-01 (maintainer, /quest-plan in moq-dev/moq). After `quest land`
removed [moq-dev/moq#7318](https://github.com/moq-dev/moq/pull/7318) with
`merge_conflict`, the fixer pushed its own merge of main,
[229973492b](https://github.com/moq-dev/moq/commit/229973492ba403cd414161c69c98e67680907e23),
which rebuilt `bun.lock` from the PR's side instead of main's. That undid
[moq-dev/moq#7443](https://github.com/moq-dev/moq/pull/7443)'s glob/minimatch
advisory fix: `glob@10.5.0` (with `jackspeak` and `path-scurry@1.11.1`) and
`minimatch@9.0.9` came back, and `bun audit` reported two moderate advisories,
GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249. The land check missed it because
moq runs `bun audit` only in Nightly. Redoing the merge from main's `bun.lock`
plus `bun install` added only the PR's packages and audited clean
([evidence](https://github.com/moq-dev/moq/pull/7318#issuecomment-6558969580)).

- ✅ Plan it: start from the base's lockfile and regenerate, size S, in this
  epic (m0)

The fixer's merge resolution is Codex following `assets/land-fix.md`, whose
only lockfile rule is "regenerate lockfiles/generated files"; nothing says
which side to start from. Replace it with a procedure: for each lockfile the
merge touches, check out the `base` branch's copy (`git checkout base --
<lockfile>`), apply the PR's manifest changes (merged `package.json`,
`Cargo.toml`, and so on), and run the package manager's minimal resolve
(`bun install`, a `cargo` build or `cargo update --workspace`, `uv lock`,
`go mod tidy`; never `cargo generate-lockfile` or an unpinned update). Then
compare the result with the base's copy and the merged manifests: every
lockfile change, and any manifest change the package manager itself made
(such as `go mod tidy` editing `go.mod`), must trace to a dependency or import
change in the PR. The fix reason names the lockfiles it rebuilt.

Hand back, quoting the command's output or the offending diff, instead of
taking either side's copy when:

- the package manager cannot rebuild the lockfile;
- a change does not trace to the PR;
- the PR's manifest no longer admits a version the base moved to, such as a
  pin below the base's security bump. Keeping either version is a behavior
  decision, not a mechanical fix.

The prompt already lets build tools fetch from package registries (from
[moq-dev/quest#356](https://github.com/moq-dev/quest/pull/356)), which
regeneration needs. `flake.lock` stays a protected path in `validateFix`, and
this quest does not open it: a fixer-written `flake.lock` comes back as a
ready commit through
[Protected edits as ready commits](/quest/m0/land-fixer/protected-commit.md),
and that edit follows the same rule, rebuilt from the base's copy with
`nix flake lock`. Both quests edit `assets/land-fix.md`, so whichever lands
second merges the other's wording.

Cover the rule in `test/land.test.ts`, which already asserts the prompt's
contents.

## Related

- [Protected edits as ready commits](/quest/m0/land-fixer/protected-commit.md) - returns a fixer-written `flake.lock` as a ready commit, built by this quest's rule
