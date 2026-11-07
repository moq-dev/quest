# Sandbox maintainers' jobs

## Goal

Every job's commands run in the OS sandbox, opencode's included, and a
maintainer can approve one exact PR head, such as one kix pushed, so its
iterate and merge jobs run on any runner. Runners keep refusing PR heads with
non-maintainer commits until
[contributor sandboxing](/quest/m1/kix/sandbox/README.md) in m1.

## Plan

Decided 2026-10-30 (user, /quest-plan): the untrusted-head VM, stock-Ubuntu
AppArmor, and macOS verification moved to
[m1](/quest/m1/kix/sandbox/README.md), since moq-dev's maintainers run their
own jobs. The decisions below still cover both epics.

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
- opencode jobs' commands run under sandbox-runtime, set as opencode's
  shell, with the same policy
  ([moq-dev/quest#338](https://github.com/moq-dev/quest/pull/338)).
  Its seccomp helper, which nixpkgs' sandbox-runtime leaves out, is built
  from source (`nix/sandbox-runtime.nix`), and the runner refuses an opencode
  account when srt lets commands make Unix sockets
  ([moq-dev/quest#465](https://github.com/moq-dev/quest/pull/465)).
  Besides disabling project config, the runner keeps the agent from creating
  a checkout's own `opencode.json` or `.opencode/` and refuses a checkout
  that holds them. Before each turn it refuses to run if opencode loaded any
  config but the runner's and the account's, since a machine's managed
  `/etc/opencode` loads above the runner's and could replace the sandboxed
  `shell`.
  `test/live/runner-sandbox.test.ts` checks that boundary with the pinned
  opencode and srt and a scripted model, and
  `test/live/runner-sandbox-claude.test.ts` checks Claude Code's the same way,
  its scripted model set as the account's endpoint in its settings. It runs in `just runner-sandbox`
  and a GitHub-hosted workflow (`.github/workflows/sandbox.yml`), nightly
  and on PRs that touch the flake, `nix/`, the dependencies, the runner, or
  these tests, not in `just test` or the merge queue, whose container can't
  mount `/proc` for bwrap, so a bump that weakens the boundary fails on its
  own PR. Decided 2026-11-03 (user, /quest-complete), after the merge
  queue dropped [moq-dev/quest#404](https://github.com/moq-dev/quest/pull/404):
  its own CI, nightly, so landing never blocks on it.
- Decided 2026-10-24 (user) in `/quest-plan`: split the remaining work into
  the children below, ranked so the earliest unblock the most. Dropped
  (user): read-only registry access, which Claude Code's sandbox cannot
  filter by request today, and a cancellable `Workspace.prepare` fetch.
- Sources:
  [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
  and [sandbox-runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime).

## Required

- [Per-job opencode saved output](/quest/m0/kix/sandbox/opencode-data.md) - each opencode job saves its tool output and shell captures beside its checkout, so no job reads another's, while sessions and the credential stay in the account's database
