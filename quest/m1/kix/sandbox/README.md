# Run contributors' PR heads on sandboxed runners

## Goal

Jobs on PR heads containing non-maintainer commits route to Linux runners,
which build the PR's devShell in a per-job VM before its commands run in the
OS sandbox. The sandbox starts on stock Ubuntu, and it is verified on macOS,
which lifts the owner's approval of another maintainer's answer.

## Plan

Split from [the m0 sandbox epic](/quest/m0/kix/sandbox/README.md) on
2026-10-30 (user, /quest-plan): moq-dev's maintainers run their jobs on
trusted or approved heads, so untrusted heads stay refused until m1. The
design decisions for the whole sandbox stay in the m0 epic's Plan.

## Required

- [macOS sandbox](/quest/m1/kix/sandbox/macos.md) - the boundary verified under Seatbelt, then the answer-approval gate removed
- [Ubuntu AppArmor](/quest/m1/kix/sandbox/apparmor.md) - the sandbox starts on stock Ubuntu, or the runner refuses at startup
- [Untrusted devShells](/quest/m1/kix/sandbox/vm.md) - untrusted PR heads build their devShell in a per-job VM
