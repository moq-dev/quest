# [S] The fixer reaches package registries

## Goal

The fixer container can fetch dependencies from the package registries a
repository's lockfiles name, so `cargo`, `bun`, `uv`, and `go` build and test
a fix before the fixer reports `fixed` or `requeue`. It reaches nothing else:
not GitHub's API, and no credentials enter the container.

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

Host work is in kixelated/nixos `modules/quest-land.nix`. Today the fixer
image has no caches (`freshFixer`), and its network reaches only CLIProxyAPI.
The check containers already reach the registries, so reuse that allowlist:
crates.io, its index and static hosts, npm, PyPI, and the Go proxy. Git
dependencies come from `github.com` and `codeload.github.com` over HTTPS; keep
`api.github.com` unreachable.

`assets/land-fix.md` then tells the fixer to build and test the packages its
fix touches, and to report what it ran in the result's reason. A fix it could
not verify hands back with the command's output.

## Related

- [Fixer proxy access](/quest/m0/host-land/fixer.md) - the container's existing network rules
