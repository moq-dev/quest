# [S] The fixer rebuilds a conflicted lockfile from the base's copy

## Goal

When the fixer resolves a lockfile while merging the base (`bun.lock`,
`Cargo.lock`, `uv.lock`, `go.sum`, `flake.lock`, and the like), it starts
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
compare the result with the base's copy: every change must trace to a
manifest change in the PR. The fix reason names the lockfiles it rebuilt.

Regeneration fetches packages, which
[Registry network](/quest/m0/land-fixer/network.md) allows. A lockfile the
fixer cannot rebuild hands back with the command's output instead of taking
either side's copy. `flake.lock` follows the same rule once
[Protected edits](/quest/m0/land-fixer/protected.md) lets the fixer edit it.
Both PRs also edit `assets/land-fix.md`, so expect to merge their wording.

Cover the rule in `test/land.test.ts`, which already asserts the prompt's
contents.

## Related

- [Registry network](/quest/m0/land-fixer/network.md) - lets the fixer fetch what a lockfile names, which regeneration needs
- [Protected edits](/quest/m0/land-fixer/protected.md) - opens `flake.lock` to the fixer
