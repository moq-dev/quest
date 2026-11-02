# Contributing

Use an isolated worktree under `.worktrees/` when practical. Keep each change
focused on an independently reviewable outcome. Plan durable work in `quest/`.

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
`direnv allow`. The Claude SessionStart hook loads an already-approved environment;
it does not grant approval. No background garbage collection runs on entry.

`flake.lock` pins Bun and the developer tools; `bun.lock` pins the
dependencies. `packageManager` in `package.json` names the same Bun for CI
runners without Nix, and `nix flake check` fails when the two disagree. Without
Nix, install the tools listed in `flake.nix` and run the same just recipes.

`just test` runs vitest, the shell hook suites, the built CLI's lifecycle check,
and the Worker tests. `just check` includes TypeScript, formatting, workflow,
shell, and Nix checks in addition to quest validation.

`nix build` builds the package; `nix run -- --help` runs it. `nix flake check`
builds the Nix package and validates the repository's quest tree.

Use conventional commit subjects. Keep PR descriptions concise: explain the
problem, resulting behavior, validation, and any limitations. Start PRs as drafts
and mark them ready after checks pass. Merge only within the user's authorized
scope and after required repository checks and reviews pass. Never block on a
CodeRabbit review; it is optional.
Quest execution stops at PR creation; it merges only when the user picks /quest-merge.

On a PR whose author has write access, the PR body's `## Review` record of a
local `quest review` round satisfies the guide's required review when it names
the exact head being landed, with no finding left unfixed or unrefuted; so does
a recorded skip of a trivial change.
A hand-resolved conflict outside the exemptions below needs a local review of the new head, but does not
require a maintainer review specifically. The guide's exemptions for a
conflict-free base merge, a reviewer's suggested patch applied unchanged, or a land
fixer's recorded mechanical fix that changes no behavior still apply. Online reviewers' findings already posted are addressed at merge,
never waited for. Dependabot PRs that only bump patch versions or a lockfile
need no review.

PRs land on `main` only through `quest land` (see the README): queue one with
`quest merge <pr> --land <sha>`, and the host daemon
`quest land serve` runs `just check` and `just test` once per batch through its
configured sandbox. Before each landing, the daemon merges the base into the PR
head with the quest merge driver and verifies the tested tree, then pushes that
head with a lease and squash-merges it through GitHub. If branch permissions
refuse the push, it fast-forwards the base to the tested squash with a lease and
closes the PR with a linked-commit comment instead. A confirmed conflict parks only
that PR for the fixer, and a moved head or a prepared tree mismatch ejects only that PR; the
rest of the batch stays queued. Transient refusals are retried; a racing base rebuilds the queue; already merged PRs stay merged. Failed batches are ejected together, with
a log tail in each comment and the full log retained on the host. The optional
credential-free `quest land fix` container makes one mechanical attempt per
maintainer pick. The daemon validates and lease-pushes fixes, records the new
head in Review, and requeues healthy PRs; other results are handed back. A fix
whose push GitHub refuses is handed back with its resolution, which
`quest land apply <pr>` rebuilds as a commit for a maintainer to push. The admin bypass of `main`'s
ruleset is for emergencies.

Every AI-authored GitHub post must end with `(written by <model>)`, naming the
running model. This is separate from commit co-author trailers.

The package stays `private`; GitHub releases will ship the `quest` binary.

## Releases

Pushing a `vX.Y.Z` tag that matches `package.json`'s version runs the Release
workflow. It compiles `quest` with Bun for macOS, Linux, and Windows (arm64 and
x64), runs the lifecycle check on each binary's native runner, and publishes the
macOS/Linux tarballs, Windows ZIPs, `SHA256SUMS`, and `quest-installer.sh` to a
GitHub release. It then checks that mise and the installer (or, on Windows, the
ZIP archive) install the tag on every platform. A tag with a
prerelease suffix publishes a prerelease. `just compile` builds a binary for
this machine; the Bun in the Nix shell is the version releases use.

Do not push release tags or publish GitHub releases from ordinary development
work; that is a maintainer action after review.
