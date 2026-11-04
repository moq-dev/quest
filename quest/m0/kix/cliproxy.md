# [L] Runner account pool through CLIProxyAPI

## Goal

`quest runner` always runs its own CLIProxyAPI, and every Claude Code job
and review and every Codex review routes through it, so work spreads across
the runner's pooled subscriptions and fails over between them instead of
draining one login. `quest runner account add` for Claude or Codex signs the
subscription into that pool. When the whole pool hits a usage limit, the
runner marks it limited until the reset the proxy reports, and later work
waits or goes to another runner. opencode accounts, including the ChatGPT
plans opencode jobs run on, stay as they are.

## Plan

Decided 2026-11-04 (user, /quest-complete follow-up of
[moq-dev/quest#471](https://github.com/moq-dev/quest/pull/471)). #471 made
`quest review` throw `ReviewLimitError` with the reset time, but the
runner's `#review` in `src/runner/job.ts` reports it as a generic failed
review and never calls `ctx.limited`. So `reviewerFor` in
`src/runner/review.ts` keeps picking the same limited Claude account, and
every later delivery lands unreviewed. The maintainer asked why one account
hits its limit at all, when CLIProxyAPI (already running on the
maintainer's hosts as `cliproxy-personal.service`, and the host gate's
route to Codex) rotates across accounts. This supersedes the epic's
2026-10-15 "Many accounts, no rotation" decision for Claude and Codex.

- What should the quest's goal be?
  - Asked first: mark the limited account and retry the review with another
    one, or only mark it. The maintainer instead asked to route through
    CLIProxyAPI.
  - ✅ Route through CLIProxyAPI
  - Rejected: mark and retry per account; mark only
- How should the runner use CLIProxyAPI?
  - First picked an optional gateway account kind; the maintainer then said
    "maybe always use cliproxy".
  - ✅ A runner-managed proxy for every Claude and Codex account
  - Rejected: an optional gateway account kind beside per-account homes;
    always, but through a proxy each operator runs themselves; reviews only;
    no code, setting `ANTHROPIC_BASE_URL` on runner hosts only
- Which vendors?
  - ✅ Claude and Codex
  - Rejected: Claude only
- Which milestone?
  - ✅ m0
  - Rejected: m1; m2

The runner has no Codex adapter (`AdapterName` in `src/runner/adapter.ts`
is Claude Code or opencode): jobs on ChatGPT plans run through opencode,
which the epic's 2026-10-15 decision keeps until it falls short, and Codex
only reviews, today with the login of the user running the runner. So
Codex's share of the pool is its reviews.

Implementation guidance:

- Package CLIProxyAPI with the runner (nixpkgs' `cliproxyapi`, which
  builds for Linux and aarch64-darwin, in the runner's flake output), and
  have `quest runner` start it bound to `127.0.0.1` with `oauth.auth-dir`
  in the runner's home and a generated client key in `access.api-keys`,
  and stop it with the runner.
- `quest runner account add` logs into the proxy's auth directory instead
  of a per-account `CLAUDE_CONFIG_DIR`, through the proxy's own flows:
  `-claude-login` for a Claude subscription and `-codex-login` or, on a
  remote runner, `-codex-device-login` for Codex, with `-no-browser` and
  `-oauth-callback-port` for a headless Claude login. The proxy has no
  Console login, so `--console` takes a Console API key into the config's
  `api-keys.claude` instead. Its `routing.strategy` is round-robin by
  default (also weighted-round-robin and fill-first); a credential that
  fails with 429 cools down while `request-retry` rounds try the others.
- Claude jobs and reviews run with `ANTHROPIC_BASE_URL` (the proxy's
  origin) and `ANTHROPIC_AUTH_TOKEN` (the client key) and no stored login,
  as `quest review` already honors. The runner sets both itself, since
  `jobEnvironment` (`src/runner/claude.ts`) drops ambient variables. Codex
  reviews run with `OPENAI_BASE_URL` (the proxy's Responses endpoint,
  including `/v1`) and the client key as `CODEX_API_KEY`, which `codex
  exec` reads and `quest review` passes only while `CODEX_HOME` holds no
  stored login, so the runner gives it an empty one; the host gate's fixer
  passes the same pair.
- The agent CLI, which runs outside the command sandbox, reaches the proxy;
  the sandboxed commands must not, so keep loopback out of their network
  allowlist and the client key out of their environment and readable
  files. The agent sees only the proxy's client key, never a subscription's
  OAuth token, which is tighter than per-account homes today.
- Per-account selection collapses to one pool per vendor: `reviewerFor`,
  `limitedUntil`, and kix's per-runner account ranking and paused sessions
  become per pool. When every credential for a model is cooling down, the
  proxy answers 429 with `{"error":{"code":"model_cooldown",...,
  "reset_seconds":N}}` and `Retry-After`, rather than the provider's own
  limit message or Claude Code's `rate_limit_event`, so #471's `LIMIT`
  matcher alone misses it. Check what each CLI surfaces from that answer,
  and recognize it in jobs and in `quest review` (`ReviewLimitError`). Catch
  `ReviewLimitError` in the runner's review path and mark the pool limited
  until its reset (a fallback window when unknown). Report the reset in the
  unreviewed note.
- Migrate existing Claude accounts (their homes under `accounts/<id>`) into
  the pool, or say how to re-add them, and update README's runner section,
  the runner's `--help`, kix's account UI, and the epic's rehearsal items
  that assume per-account Claude homes and `resetsAt`.

## Required

- [Reviewer usage limits](/quest/m0/review-quota.md) - `quest review` throws `ReviewLimitError` with the reset, which the runner catches
