# [S] Deploy the Worker to quest.moq.dev

## Goal

The Worker's checked-in origin is `https://quest.moq.dev`, and an operator
registers the GitHub App and deploys `main` there with GitHub sign-in pointed
at it. The condition clears when `https://quest.moq.dev/health` returns
`{"status":"ok"}`, `https://quest.moq.dev/setup` redirects to `SETUP.md`, a
browser sign-in and sign-out succeed, and the App's ping to
`https://quest.moq.dev/webhooks/github` shows a successful delivery. Follow
the Deployment section of `cloudflare/README.md` and steps 1, 2 and 4 of
`cloudflare/GITHUB.md`; delete this quest once verified.

## Plan

- ✅ Decided 2026-10-30 (user, /quest-plan): host at quest.moq.dev, not
  kix.quest, until [the public release](/quest/m1/open.md), so nothing public
  is launched before it works for moq-dev. Change the origin in
  `cloudflare/wrangler.jsonc` (route and `AUTH_URL`),
  `cloudflare/worker-configuration.d.ts`,
  `cloudflare/github-app-manifest.json`, `quest runner`'s `DEFAULT_URL`
  (`src/runner/cli.ts`) and its examples, and the docs that name kix.quest as
  the live origin. The product keeps the kix name.
- ✅ Decided 2026-10-14: deprecate kixel.quest without redirects or legacy
  auth handling, because nobody uses it. quest.moq.dev is the only site and
  authentication origin (amended 2026-10-30, was kix.quest). Remove the Worker's kixel.quest custom domain when
  deploying; the checked-in config no longer lists it.
- Merging to `main` does not deploy: no workflow runs Wrangler, and
  deployment is a manual `bun run deploy` from `cloudflare/`.
- Every deploy of `main` fails until the required secrets `AUTH_SECRET`,
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and
  `GITHUB_WEBHOOK_SECRET` are set, so register the App from
  `cloudflare/github-app-manifest.json` first. Review its permissions and
  events before registering, and set `GITHUB_APP_ID`. Keep secrets out of
  git and agent worktrees.
- Apply the D1 migrations, including `0002_github.sql`, with
  `bun run wrangler d1 migrations apply DB --remote` before deploying.
- Once raw output retention (#142) merges, create the `quest-output` R2
  bucket and its 30-day `output/` lifecycle rule before deploying, as #142
  adds to the README's Deployment section, and confirm the rule with
  `bun run wrangler r2 bucket lifecycle list quest-output`. Until then,
  `main` has no R2 binding and needs no bucket. Decided 2026-10-18.
- Serve the Worker on `quest.moq.dev` from the `moq.dev` zone, which
  already hosts `token.moq.dev`; if that zone sits in another Cloudflare
  account, say which in `cloudflare/README.md`. Keep the
  Worker name, D1 database ID, and `AUTH_SECRET`; do not create a new
  production database.
- Set the production GitHub App's homepage to `https://quest.moq.dev` and
  its callback to `https://quest.moq.dev/api/auth/callback/github`.
- The deploy deletes the legacy `RepositoryCoordinator` Durable Object and
  any storage it held, approved 2026-10-14 since nothing is stored. Afterwards
  remove its `exports` tombstone from `cloudflare/wrangler.jsonc`.
