# [XS] The fixer's container trusts public TLS certificates

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

Fixed in [kixelated/nixos#21](https://github.com/kixelated/nixos/pull/21)
([moq-dev/quest#440](https://github.com/moq-dev/quest/pull/440)). The cause:
workerd's bundled BoringSSL trusts only `SSL_CERT_FILE` or its default
`/etc/ssl/cert.pem`, while the land image shipped only
`/etc/ssl/certs/ca-certificates.crt` and `NIX_SSL_CERT_FILE`. The check and
fixer containers boot the same image, so both had the gap. The fix links
`/etc/ssl/cert.pem` to the bundle. Run against the built image's `/etc/ssl`,
workerd's outbound `fetch` succeeds.

What remains is deploying it and checking it on the live host.

## Waiting

- Maintainer: deploy [kixelated/nixos#21](https://github.com/kixelated/nixos/pull/21)
  through `deploy/quest-land`, since only the maintainer activates the live
  host. Then check that a fixer job on a moq-dev/quest PR that touches
  `cloudflare/` runs `cd cloudflare && bun run test` without the TLS error,
  or run the Worker tests by hand in a fixer container.
