# [L] The runner drives opencode 2.x through @opencode/client

## Goal

The runner's opencode adapter (`src/runner/opencode.ts`) runs the opencode
2.x binary that nixpkgs ships as a server and drives it through
`@opencode/client` at the same version. The temporary second nixpkgs input
that keeps opencode at 1.19.0 is gone. The flake's `opencode-sdk` check
compares `@opencode/client` with `pkgs.opencode.version`. The runner's
opencode tests pass, and the opencode sandbox's boundary still holds on 2.x.

## Plan

Decided 2026-11-02 (maintainer, /quest-plan from the 2026-11-02
`/quest-complete` session), replacing the 2026-11-01 plan to move to the
renamed `@opencode/sdk`. Checked against nixpkgs 674a202, which ships
opencode 2.1.1:

- `@opencode-ai/sdk` stops at 1.19.5, so there is no 2.x of the package the
  runner pins.
- `@opencode/sdk` 2.1.1 runs opencode inside the calling process.
- The client for a running server is `@opencode/client`, with a new API.
- The CLI has no `serve`: it runs a background `service` or a
  `--standalone` server, so the adapter's `serve --port=0` launch and its
  "listening on" handshake both break.

Decision prompts, selected options marked ✅:

- How the runner drives opencode 2:
  - ✅ The 2.1.1 binary as a server, driven by `@opencode/client` 2.1.1. It
    keeps the split [the opencode sandbox](/quest/m0/kix/sandbox/opencode.md)
    relies on: the server process holds the provider credentials, the server
    password, and the kix tools' token, outside the commands' boundary.
  - `@opencode/sdk` in the runner's process, dropping the binary. The
    runner would hold the credentials, and the sandbox's process boundary
    would need redesigning.
- Whether the nixpkgs bump waits for this:
  - ✅ No. [moq-dev/quest#281](https://github.com/moq-dev/quest/pull/281)
    lands now with opencode 1.19.0 from a second nixpkgs input pinned at
    f20cd90, since the same nixpkgs also brings the runners' other agent
    CLIs, such as claude-code. This quest removes that input.
  - Keep #281 blocked until the migration.

What the change does:

- Launch the server the way 2.x supports, with `--standalone` unless
  `service` fits the runner's per-job lifetime better. Replace the
  "listening on" handshake with whatever 2.x reports for readiness.
- Move the adapter to `@opencode/client`. Point the flake's check and
  Dependabot's ignore for the SDK (it must move with nixpkgs' opencode) at
  `@opencode/client`.
- Recheck each of the sandbox's rules on 2.x: the `shell` wrapper through
  srt, stripping `OPENCODE_*` from the commands' environment,
  `OPENCODE_DISABLE_PROJECT_CONFIG`, `external_directory` and `webfetch`
  denies, the plugin's realpath check, and `lsp`/`formatter` off. Rerun the
  sandbox's hostile-repository boundary test against 2.x.
- Run the runner's live opencode checks that the
  [Kix decision UI](/quest/m0/kix/README.md) rehearsal lists, if a runner is
  available.

## Required

- [Sandbox opencode jobs' commands](/quest/m0/kix/sandbox/opencode.md) - the sandbox this migration must keep, in [moq-dev/quest#338](https://github.com/moq-dev/quest/pull/338)
