# Run untrusted PR heads on sandboxed runners

## Goal

Jobs on PR heads containing non-maintainer commits route to Linux runners,
which build the PR's devShell in a per-job VM before its commands run in the
OS sandbox every Claude Code job already uses. opencode jobs' commands run in
that sandbox too. kix classifies PR heads whose commits all
carry a current maintainer's valid signature as trusted, so those run on any runner. The
sandbox is verified on macOS, and the owner's approval of another
maintainer's answer is lifted once it is.

## Plan

Decided 2026-10-15, from Codex's review of moq-dev/quest#121:

- A Nix devShell is not an isolation boundary, and maintainers' machines
  must not run contributor-controlled code unconfined. Sandbox all jobs, not
  just untrusted ones: one execution path, which also contains prompt
  injection from untrusted issue text.
- OS sandbox, not a VM per job: bubblewrap on Linux and Seatbelt on macOS.
  Claude Code's docs say this does not replace a container or VM; the README
  documents that residual risk.
- Untrusted heads build their devShell in a per-job VM on a Linux runner
  before their commands run in the OS sandbox. macOS runners take trusted
  revisions only, since a Linux VM cannot build a darwin devShell. An
  untrusted-head job waits with "needs a Linux runner" while none is online.
  Cloud runners are Linux-only.
- Decided 2026-10-22 on
  [moq-dev/quest#188](https://github.com/moq-dev/quest/pull/188), from
  Codex's security review: a job resumes with an answer from a maintainer
  other than the runner's owner (the job's requester) only after the owner
  approves it in the inbox, since the agent would act on that text with the
  owner's machine. kix holds the job and the runner refuses an answer
  without `approvedAt`. The sandbox lifts this gate once it is verified on
  macOS.

Shipped in [moq-dev/quest#212](https://github.com/moq-dev/quest/pull/212)
(`src/runner/sandbox.ts`), and verified live on Linux with Claude Code
2.1.291 and 2.1.305:

- Claude Code's sandbox runs every command in `dontAsk` mode with
  `--setting-sources user`, since a checkout's `.claude/settings.json` hooks
  run outside the sandbox even in `-p` mode. The file tools edit and read
  only the checkout, and WebFetch is off.
- The runner builds the devShell with `nix print-dev-env` from the job's
  revision in the bare clone, never the edited checkout, and Claude Code
  sources it through `CLAUDE_ENV_FILE` inside the sandbox, shellHook
  included.
- Commands have no Nix daemon: on Linux the sandbox's seccomp filter
  refuses Unix sockets, and allowing them all would expose every socket on
  the filesystem, while a trusted Nix user could reach the daemon's
  root-level options. `nix build` and `nix flake check` run in CI instead.
- Decided 2026-10-24 on
  [moq-dev/quest#212](https://github.com/moq-dev/quest/pull/212): a
  trusted revision's commands reach a fixed list of package registries
  (npm, crates.io's index and downloads, PyPI), since most repositories
  cannot run their checks without installing dependencies. An untrusted
  revision's commands reach no network host. The answer-approval gate stays
  until the sandbox is verified on macOS.
- Decided 2026-10-24 (user) on the same PR: opencode jobs keep running
  their commands unconfined, as before the sandbox, until
  [opencode sandboxing](/quest/m0/kix/sandbox/opencode.md) ships. The README
  says so.
- Decided 2026-10-24 (user) in `/quest-plan`: split the remaining work into
  the children below, ranked so the earliest unblock the most. Dropped
  (user): read-only registry access, which Claude Code's sandbox cannot
  filter by request today, and a cancellable `Workspace.prepare` fetch.
- Sources:
  [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
  and [sandbox-runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime).

## Required

- [Head approval](/quest/m0/kix/sandbox/head-approval.md) - a maintainer approves an exact head, such as one kix pushed, for host runners
- [opencode sandboxing](/quest/m0/kix/sandbox/opencode.md) - opencode jobs' commands run in the same sandbox as Claude Code's
- [macOS sandbox](/quest/m0/kix/sandbox/macos.md) - the boundary verified under Seatbelt, then the answer-approval gate removed
- [Ubuntu AppArmor](/quest/m0/kix/sandbox/apparmor.md) - the sandbox starts on stock Ubuntu, or the runner refuses at startup
- [Untrusted devShells](/quest/m0/kix/sandbox/vm.md) - untrusted PR heads build their devShell in a per-job VM
