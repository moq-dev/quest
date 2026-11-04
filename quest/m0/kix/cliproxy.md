# [L] Runner account pool through CLIProxyAPI

## Goal

`quest runner` always runs its own CLIProxyAPI, and every Claude and Codex
job and review routes through it, so work spreads across the runner's pooled
subscriptions and fails over between them instead of draining one login.
`quest runner account add` for Claude or Codex signs the subscription into
that pool. When the whole pool hits a usage limit, the runner marks it
limited until the reset it reports, and later work waits or uses another
pool. opencode accounts stay as they are.

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
route to Codex) rotates across accounts.

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

Implementation guidance:

- Package CLIProxyAPI with the runner (the Nix package and its flake
  output), and have `quest runner` start it on a loopback port with an
  auth directory in the runner's home and a generated client key, and stop
  it with the runner.
- `quest runner account add` (Claude subscription, `--console`, and Codex)
  logs into the proxy's auth directory instead of a per-account
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Check which login flows and API-key
  accounts the packaged CLIProxyAPI version supports, and its routing
  strategy (round-robin or weighted) and failover on a limited account.
- Claude jobs and reviews run with `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` naming the proxy and no stored login, as
  `quest review` already honors. Codex uses the OpenAI-compatible endpoint
  (`OPENAI_BASE_URL`, including `/v1`), as the host gate's fixer does.
- The job sandbox must reach the proxy's port, and no other loopback
  service. A job sees only the proxy's client key, never a subscription's
  OAuth token, which is tighter than per-account homes today.
- Per-account selection collapses to one pool per vendor: `reviewerFor`,
  `limitedUntil`, and kix's per-runner account ranking and paused sessions
  become per pool. Catch `ReviewLimitError` in the runner's review path and
  mark the pool limited until its reset (a fallback window when unknown).
  Report the reset in the unreviewed note.
- Migrate existing Claude and Codex accounts (their homes under
  `accounts/<id>`) into the pool, or say how to re-add them, and update
  README's runner section, the runner's `--help`, and kix's account UI.
