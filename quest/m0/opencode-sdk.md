# [M] The runner's opencode adapter drives opencode 2.x through @opencode/client

## Goal

The runner's opencode adapter (`src/runner/opencode.ts`) drives the
opencode 2.x that the main nixpkgs input ships (2.1.1 at nixpkgs 674a202)
through `@opencode/client` 2.x, so the flake drops its temporary
`nixpkgs-opencode` input. The flake's `opencode-sdk` check passes against
the new package, and the runner's opencode tests pass against it.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [M], m0.

Decided 2026-11-02 (maintainer, /quest-plan): unblock
[moq-dev/quest#281](https://github.com/moq-dev/quest/pull/281) first.
It takes opencode 1.19.0 from a second nixpkgs input, `nixpkgs-opencode`,
pinned at f20cd90, which the runner, the flake's packages, and the
`opencode-sdk` check use. This quest's migration to opencode 2.1.1 with
`@opencode/client` removes that input.

- opencode 2 is a different architecture
  ([analysis](https://github.com/moq-dev/quest/pull/281#issuecomment-6567121394)).
  The CLI has no `serve` subcommand: it runs a background `opencode service`
  or a `--standalone` private server, so the adapter's launch and its
  `opencode server listening on` handshake change. `@opencode/sdk` 2.x is an
  in-process host; the HTTP client is `@opencode/client`, with a new API
  (`sessions.create({ location })`, `sessions.prompt({ prompt })`). Keep
  driving the binary over HTTP so the runner keeps its process sandbox.
  Check config, plugins, permission and question events, and the credential
  layout against 2.x.
- Wait for [moq-dev/quest#338](https://github.com/moq-dev/quest/pull/338),
  which rewrites `src/runner/opencode.ts`.
- Delete the `nixpkgs-opencode` input from `flake.nix` and `flake.lock`, use
  `pkgs.opencode` again, and point the `opencode-sdk` check at
  `@opencode/client`.
- Replace `@opencode-ai/sdk` with `@opencode/client` in `.github/dependabot.yml`'s
  bun ignore, and delete its `nixpkgs-opencode` nix ignore.
- Run the runner's live opencode checks that the
  [Kix decision UI](/quest/m0/kix/README.md) rehearsal lists, if a runner is
  available.
