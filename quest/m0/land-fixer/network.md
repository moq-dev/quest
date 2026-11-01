# [S] The fixer reaches package registries

## Goal

The fixer container can fetch dependencies from the package registries a
repository's lockfiles name, so `cargo`, `bun`, `uv`, and `go` build and test
a fix before the fixer reports `fixed` or `requeue`. It does not use GitHub's
API or push, and the only credential in the container stays the gate's
CLIProxyAPI client key ([Fixer proxy access](/quest/m0/host-land/fixer.md)).

## Plan

Decided 2026-11-01 (user, /quest-plan of the land fixer audit; see the
[epic](/quest/m0/land-fixer/README.md)). In 17 of moq's last 40 fix jobs,
`cargo` failed offline with "failed to get `uniffi` as a dependency", a git
dependency the container cannot fetch. The fixer requeued Rust fixes it never
compiled ([moq-dev/moq#7357](https://github.com/moq-dev/moq/pull/7357) sank
three batches), and could not regenerate
[moq-dev/moq#6985](https://github.com/moq-dev/moq/pull/6985)'s lockfile.

- How the fixer gets dependencies:
  - Host prefetches the job's lockfile dependencies and mounts them read-only
  - ✅ Allow registry network
  - Leave it

Found while starting the work (2026-11-01): the host is not what blocks it.
kixelated/nixos `modules/ci-egress.nix` gives the fixer container
(`qland-fix`) the same egress as the check containers, the public internet
without private ranges, and the fixer runs Codex with
`--dangerously-bypass-approvals-and-sandbox`. The fixer chooses `--offline`
itself because `assets/land-fix.md` says "Never push or contact GitHub", and
a git dependency's fetch from `github.com` is contact. So the change is the
prompt: fetching dependencies from package registries and from
`github.com`/`codeload.github.com` for git dependencies is allowed, while
GitHub's API, pushing, and any other contact stay forbidden.
[Fixer proxy access](/quest/m0/host-land/fixer.md)'s "network access only to
CLIProxyAPI" describes the intent, not the host as built; correct it in the
same PR.

`assets/land-fix.md` then tells the fixer to build and test the packages its
fix touches, and to report what it ran in the result's reason. A fix it could
not verify hands back with the command's output.

## Related

- [Fixer proxy access](/quest/m0/host-land/fixer.md) - the container's existing network rules
