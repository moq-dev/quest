# Contributing

Keep each change focused on an independently reviewable outcome. Plan durable
work in `quest/`.

Use the pinned Nix development shell, shared with CI:

```sh
nix develop
just install  # Install the locked dependencies
just check
just test
just fix  # Apply formatting
just build
```

For automatic shell loading, install direnv and approve this checkout with
`direnv allow`. No background garbage collection runs on entry.

`flake.lock` pins Bun and the developer tools; `bun.lock` pins the
dependencies. `packageManager` in `package.json` names the same Bun for CI
runners without Nix, and `nix flake check` fails when the two disagree. Without
Nix, install the tools listed in `flake.nix` and run the same just recipes.

`nix build` builds the package; `nix run -- --help` runs it. `nix flake check`
builds the Nix package and validates the repository's quest tree.

Use conventional commit subjects. Keep PR descriptions concise: explain the
problem, resulting behavior, validation, and any limitations.

On a PR whose author has write access, the PR body's `## Review` record of a
local `quest review` round satisfies the required review `/quest-merge` describes when it names
the exact head being landed, with no finding left unfixed or unrefuted; so does
a recorded skip of a trivial change.
`/quest-merge`'s exemptions still apply; a hand-resolved conflict outside them
needs a local review of the new head, but not a maintainer review specifically.
Dependabot PRs that only bump patch versions or a lockfile
need no review.

PRs land on `main` through GitHub's merge queue, one PR at a time, as squash commits.
Queue the reviewed head with `quest merge <pr> --land <sha>` (`/quest-merge` does this).
The `Pullfrog approval` ruleset requires Pullfrog's approval of the head, which the queue waits for; other online reviewers are never waited for.
The required `Queue` check skips on pull requests; the merge group runs `just check` and `just test` on the self-hosted runner.
That build lives in `.github/workflows/queue-build.yml`, which the merge group calls from `main`, so a PR's edit to it runs only after the PR lands.
The host runs one `quest land watch` daemon per base, here `main`'s; it runs the Codex fixer when the queue drops a PR for a failed build or a conflict, and re-enqueues healthy heads at the back of the queue.
The fixer resolves mechanical causes itself and pushes the fix onto the PR's branch: conflicts that keep both sides' intent, formatting and lint, generated files, lockfiles rebuilt from the base's copy, and build or test failures with an obvious fix, built and tested with registry access.
It hands back, with a diagnosis on the PR, anything that needs a behavior or design decision; a fix that edits protected paths (`flake.nix`, `.github/`, ...) or that GitHub refuses to push comes back as a ready commit for `quest land apply <pr>`.
The admin bypass of `main`'s ruleset is for emergencies.

The package stays `private`; GitHub releases will ship the `quest` binary.

## Releases

The Release workflow cuts every release; no person or agent tags one. Each
push to `main`, a daily schedule, and a manual run on `main` compare `main`
with the latest published release, and cut the next one when that range
changes what ships, as `scripts/release-plan.sh` decides: everything the
binaries and the flake package build from, every file Release publishes, and
the workflows that build and check them. Its pull request runs use the same
predicate to decide whether to build. The next version is greater than every
`vX.Y.Z` tag: a minor bump (a major one from 1.0) when a commit subject in the
range has `!` before its colon, a patch bump otherwise.

A run compiles `quest` with Bun for macOS, Linux, and Windows (arm64 and x64),
each binary embedding its version, and runs the lifecycle and archive install
checks on each binary's native runner. Only then does it upload the
macOS/Linux tarballs, Windows ZIPs, `SHA256SUMS`, and `quest-installer.sh` to
a draft release and publish it, which creates the tag. A run that fails or is
cancelled needs no recovery: the next one sees the same unreleased range and
replaces the draft. After publishing, it checks that mise and the installer
install the release on every platform; a failure there ships its fix as the
next release.

`package.json` carries no version. A release binary reports its tag in
`quest --version`, a flake build its commit, and a checkout run from source
`dev`. `just compile` builds a binary for this machine; the Bun in the Nix
shell is the version releases use.

Do not push release tags or publish GitHub releases by hand.
