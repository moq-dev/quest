# [S] Deploy the Worker to quest.moq.dev

## Goal

An operator registers the GitHub App and deploys `main` to
`https://quest.moq.dev`, the origin the checked-in config, App manifest,
`quest runner`'s default `--url`, and docs already name, with GitHub sign-in
pointed at it. The condition clears when `https://quest.moq.dev/health`
returns `{"status":"ok"}`, `https://quest.moq.dev/setup` redirects to
`SETUP.md`, a browser sign-in and sign-out succeed, and the App's ping to
`https://quest.moq.dev/webhooks/github` shows a successful delivery. Follow
the Deployment section of `cloudflare/README.md` and steps 1, 2 and 4 of
`cloudflare/GITHUB.md`; then remove the `exports` tombstone below and delete
this quest.

## Plan

- ✅ Decided 2026-10-30 (user, /quest-plan): host at quest.moq.dev, not
  kix.quest, until [the public release](/quest/m1/open.md), so nothing public
  is launched before it works for moq-dev. The product keeps the kix name.
- ✅ Decided 2026-10-14: deprecate kixel.quest without redirects or legacy
  auth handling, because nobody uses it. quest.moq.dev is the only site and
  authentication origin. The checked-in config no longer lists kixel.quest.
- As of 2026-11-02, quest.moq.dev has no DNS record and kixel.quest still
  serves an earlier deploy (`/health` returns `{"status":"ok"}`).
- Merging to `main` does not deploy: no workflow runs Wrangler, and
  deployment is a manual `bun run deploy` from `cloudflare/`.
- Keep the Worker name, D1 database ID, and `AUTH_SECRET`; do not create a
  new production database.
- ✅ Decided 2026-11-03 (user, /quest-complete): if the `moq.dev` zone is
  not in the Worker's Cloudflare account, add the zone to that account,
  which keeps the Worker and its D1 database. Moving the Worker to the
  zone's account was rejected, since it needs a new production database.
- The deploy deletes the legacy `RepositoryCoordinator` Durable Object and
  any storage it held, approved 2026-10-14 since nothing is stored.
  Afterwards remove its `exports` tombstone from `cloudflare/wrangler.jsonc`
  in the PR that deletes this quest.

## Waiting

- Maintainer: confirm the `moq.dev` zone, which already hosts `token.moq.dev`,
  sits in the same Cloudflare account as the `quest-cloudflare` Worker, since
  a Workers custom domain requires it; if it does not, add the zone to the
  Worker's account, as the Plan decides. Check it in the Cloudflare
  dashboard, where `moq.dev` is listed under the Worker's account. Agents hold
  no Cloudflare credentials.
- Maintainer: register the production GitHub App from
  `cloudflare/github-app-manifest.json` (homepage `https://quest.moq.dev`,
  callback `https://quest.moq.dev/api/auth/callback/github`, webhook
  `https://quest.moq.dev/webhooks/github`) after reviewing its permissions and
  events, or update an existing App to those URLs, and set `GITHUB_APP_ID` in
  `cloudflare/wrangler.jsonc`. Registration returns secrets an agent must
  never handle.
- Maintainer: set the Workers secrets `AUTH_SECRET` (kept from the existing
  deployment), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
  `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` with
  `bun run wrangler secret put NAME`; every deploy fails until they are set.
  Secrets stay out of git and agent worktrees.
- Maintainer: create the `quest-output` R2 bucket and its 30-day `output/`
  lifecycle rule if missing, confirmed with
  `bun run wrangler r2 bucket lifecycle list quest-output`, then apply the D1
  migrations with `bun run wrangler d1 migrations apply DB --remote` and run
  `bun run types`, `bun run check` and `bun run deploy` from `cloudflare/`.
  These need Cloudflare credentials.
- Maintainer: remove the Worker's kixel.quest custom domain in the Cloudflare
  dashboard (Workers, Settings, Domains & Routes) if the deploy leaves it
  attached. Needs Cloudflare access.
- Maintainer: verify `https://quest.moq.dev/health` returns
  `{"status":"ok"}`, `/setup` redirects to `SETUP.md`, a browser sign-in and
  sign-out succeed, and the App's ping to `/webhooks/github` shows a
  successful delivery. Sign-in and the App's delivery log need the
  maintainer's GitHub account.
