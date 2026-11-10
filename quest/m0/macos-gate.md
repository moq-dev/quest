# [M] Gate signal tests pass on macOS before a tag

## Goal

`test/gate.test.ts` passes on macOS, and it runs there on a change to the
gate before a release tag finds it broken. The fix is at the cause, in the
process-group owner macOS uses (it has no systemd scopes) or in the tests.

## Plan

Found 2026-11-10 (/quest-unblock): the v0.2.0
[Release run](https://github.com/moq-dev/quest/actions/runs/42893603987)
published nothing. On `check (x86_64-apple-darwin)`, the step "Check the
gate's owners natively" timed out at 30 s on 10 tests in "an owner using a
process group" and "an outermost gate owning a process group under Just":
SIGTERM, SIGHUP and SIGINT delivery under Just and nested gates, a second
signal killing a phase still cleaning up, and cleanup after cancellation. The
`aarch64-apple-darwin` job was cancelled. The last macOS gate run that passed
was the manual Release run on 2026-11-03 at 352ed68c; gate changes since then
include [moq-dev/quest#585](https://github.com/moq-dev/quest/pull/585),
[#602](https://github.com/moq-dev/quest/pull/602) and
[#607](https://github.com/moq-dev/quest/pull/607). Bisect with
`gh workflow run release.yml` on candidate commits (or a macOS host), and list
the causing PR under `## Caused by`.

Nothing else runs these tests on macOS: Check's suite runs on Linux and
Windows, and Check's `lifecycle (macos-14)` job on `main` was cancelled
before getting a runner in each of the last 100 runs (and runs only
`scripts/gate-check.sh`). So a macOS regression surfaces only at a tag. Run
`test/gate.test.ts` on macOS for changes to the gate before they land, such
as on a pull request touching `src/cli/gate.ts` or `src/cli/supervise.ts`,
and keep Release's run as the last check.

Decided 2026-11-10 (maintainer, /quest-unblock): ✅ its own quest, required by
the release (rejected: fold into the release quest; re-run the release
first as runner flakiness).

## Related

- [Gate tests pass deterministically](/quest/m0/gate-test-races.md) - Linux assertion races in the same file
- [Test CPU timeout](/quest/m0/test-cpu-timeout.md) - timeouts from load rather than a hang
