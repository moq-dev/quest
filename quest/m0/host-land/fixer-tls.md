# [S] The fixer's container trusts public TLS certificates

## Goal

The land fixer's nspawn container validates TLS like a normal host, so
workerd and the Cloudflare Worker tests run there. A fixer job on
moq-dev/quest builds and tests the Worker (`cd cloudflare && bun run test`)
without workerd's "TLS peer's certificate is not trusted; reason = unable to
get local issuer certificate". Check it by re-running the fixer on a PR that
touches the Worker, or by running the Worker tests by hand in a fixer
container.

## Plan

Decided 2026-11-01 (user, /quest-plan of the follow-ups from the
2026-11-01 `/quest-complete` sessions): ✅ plan it, [S], in this epic.

- The fixer handed back
  [moq-dev/quest#331](https://github.com/moq-dev/quest/pull/331) for this
  ([handback](https://github.com/moq-dev/quest/pull/331#issuecomment-6563898322)):
  its resolution of `test/land.test.ts` was right, but it could not run the
  Worker suite, so it could not report the fix as tested.
- The fix lands in [kixelated/nixos](https://github.com/kixelated/nixos), in
  `modules/quest-land.nix`, which builds the fixer container. A likely
  cause is a missing CA bundle at the standard path, or
  `SSL_CERT_FILE`/`NIX_SSL_CERT_FILE` not reaching the fixer's dev shell.
  Confirm the cause before changing anything.
- Check the land check containers for the same gap, since they run the same
  suites.
