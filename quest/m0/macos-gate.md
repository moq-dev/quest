# [M] Release's macOS jobs run and pass

## Goal

Release's two macOS jobs get a runner and pass, so a tag publishes.
`test/gate.test.ts` passes on macOS, fixed at the cause in the process-group
owner macOS uses (it has no systemd scopes) or in the tests, and it runs there
on a change to the gate before a release tag finds it broken.

## Plan

Found 2026-11-10 (/quest-unblock): the v0.2.0
[Release run](https://github.com/moq-dev/quest/actions/runs/42893603987)
published nothing, for two separate reasons.

GitHub rejects the `macos-14` label: "The configuration
'macos-14-arm64-us-default' is not supported". Release's
`check (aarch64-apple-darwin)` job was cancelled for it, and so was Check's
`lifecycle (macos-14)` job on every push to `main` since 2026-11-05 20:45
UTC (it last ran in
[run 42079308057](https://github.com/moq-dev/quest/actions/runs/42079308057),
17:55 UTC that day). The Install check's `aarch64-apple-darwin` jobs use it
too. Move `release.yml`, `check.yml`, and `install-check.yml` to a supported
arm64 macOS label, such as `macos-15`, and confirm each gets a runner.

On `check (x86_64-apple-darwin)` (`macos-15-intel`), the step "Check the
gate's owners natively" timed out at 30 s on 10 tests in "an owner using a
process group" and "an outermost gate owning a process group under Just":
SIGTERM and SIGHUP delivery under Just and nested gates, a second signal or a
repeated SIGINT killing a phase still cleaning up, and cleanup after
cancellation. They came from
[moq-dev/quest#429](https://github.com/moq-dev/quest/pull/429) and
[moq-dev/quest#454](https://github.com/moq-dev/quest/pull/454), and CI never
ran them on macOS before this tag: the last Release run on macOS, on
2026-11-03 at 352ed68c, predates both. #454 recorded the file passing locally
on macOS 26.6.2, so bisect 45e11c7d (#454's merge) to 2572be9c (v0.2.0).
Candidates include the Bun 1.4.2 to 1.4.4 pin
([moq-dev/quest#528](https://github.com/moq-dev/quest/pull/528)) and the gate
changes [moq-dev/quest#589](https://github.com/moq-dev/quest/pull/589),
[#604](https://github.com/moq-dev/quest/pull/604),
[#602](https://github.com/moq-dev/quest/pull/602),
[#585](https://github.com/moq-dev/quest/pull/585) and
[#607](https://github.com/moq-dev/quest/pull/607). Bisect on a macOS host,
or with `gh workflow run release.yml --ref <branch>` on a branch pushed at
each candidate, and list the causing PR under `## Caused by`.

Nothing else runs these tests on macOS: Check and the merge queue run the
suite on Linux, the Windows workflow nightly on Windows, and Check's macOS
job runs only `scripts/lifecycle-check.sh` and `scripts/gate-check.sh`. So a
macOS regression surfaces only at a tag. Run `test/gate.test.ts` on macOS for
changes to the gate before they land, such as on a pull request touching
`src/cli/gate.ts`, `src/cli/supervise.ts`, or `src/cli/interrupt.ts`, and
keep Release's run as the last check. Release skips macOS on pull requests
because hosted macOS runners can queue past the job timeout, so the new job
must not fail a PR for a runner that never started.

Decided 2026-11-10 (maintainer, /quest-unblock): ✅ its own quest, required by
the release (rejected: fold into the release quest; re-run the release
first as runner flakiness).

## Related

- [Gate tests pass deterministically](/quest/m0/gate-test-races.md) - Linux assertion races in the same file
- [Test CPU timeout](/quest/m0/test-cpu-timeout.md) - timeouts from load rather than a hang
