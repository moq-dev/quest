# Kix decision UI

## Goal

kix.quest is a cloud for creating software. Maintainers make decisions in a
phone-friendly web app with push notifications, while kix routes the work to
any runner they own, using whatever agent accounts they connect. CLIs and
providers stay hidden behind summaries and prompts.

A new GitHub issue leads into a quest-plan interview, ready quests can be
started, and each new PR brings the next review or iteration decision: the
existing skills' workflow, through the web. Runners are the maintainer's own
Linux and macOS machines, which come and go offline. Each one drives the
official agent CLIs (Claude Code, opencode) with any number of signed-in
accounts. The GitHub App bot publishes ordinary PRs.

This epic owns an end-to-end test of the whole flow: enroll a project,
connect a Linux and a macOS runner, one with two accounts, receive an issue notification,
answer planning prompts, publish a draft quest PR, merge through GitHub's
rules, start a ready quest, follow its summaries, answer an implementation
question from a push notification, take its runner offline so the job is
reassigned to the other, receive its contribution PR notification, and pick
merge on it while it is not yet clean, so a merge job fixes and lands it. Exercise duplicate events,
interrupted sessions, and an exhausted account with stubbed agents, starting
from the seeded local server's fake GitHub and seed (`cloudflare/dev/`), before a
live rehearsal on the operator's runner.

## Plan

Decided on 2026-10-15 through the decisions-not-implementations interview,
superseding the 2026-10-13 hosted-first, Claude-SDK-only, and
operator-paid-hosting decisions:

- **Decisions, not implementations.** The maintainer only makes decisions;
  agents do all the implementing. Prompts and agent-written summaries are
  the whole default UI. Raw agent output is collapsed behind a per-job
  disclosure that only current maintainers can expand.
- **Phone first.** m0 ships an installable PWA with Web Push for decision
  items. A [native mobile app](/quest/m1/mobile-app.md) follows in m1.
- **Your own runners first.** `quest runner` turns any Linux or macOS machine
  into a runner. It claims jobs over HTTPS and drives the official CLIs with
  that machine's own logins, so kix never holds provider tokens. There are no
  Windows runners. Free, capped [cloud runners](/quest/m1/cloud/README.md)
  and API-key or donor funding follow in m1, with paid compute later.
- **Abstract the CLIs.** A runner adapter interface hides each CLI: start or
  resume, structured questions, checkpoint summaries, and results. Claude
  Code covers Claude subscriptions; opencode covers OpenCode Go, ChatGPT
  plans, and API-key providers. There is no separate Codex adapter unless
  opencode's ChatGPT support falls short.
- **Many accounts, no rotation.** A runner offers any number of accounts,
  each signed in by its own CLI in an isolated home. kix stores opaque
  account IDs and routes by the user's preference order. A job that hits a
  limit pauses with a decision to switch accounts; kix never rotates
  automatically to dodge provider limits.
- **Nix only.** Runners run every job inside the project's `nix develop`
  shell, with no other way to install dependencies, for cache efficiency and
  reproducibility. The runner pins the agent CLIs through Nix as well.
  Runners keep a persistent local store and honor the flake's substituters;
  a [shared cache](/quest/m1/automation/cache.md) follows in m1.
- **Sandboxed jobs.** Every job's commands run in an OS sandbox. PR heads
  with non-maintainer commits route to Linux runners, which build the PR's
  devShell in a VM first; macOS runners take trusted revisions only. Cloud
  runners are Linux-only.
- **Auto-routing.** kix picks an online runner with a usable account; the
  maintainer may pin one. Runners push checkpoints, through the service, to
  the job's fenced branch, and an offline runner's job is reassigned
  automatically from that branch.
- **GitHub first.** GitHub owns repositories, issues, PRs, reviews, and
  existing CI. No Artifacts mirror, separate changes system, git-note
  approvals, or custom merge executor. GitHub merges require a maintainer's
  explicit choice and the repository's checks and protections.
- **A real GitHub App bot.** The service publishes as its App identity and
  keeps GitHub credentials off runners. It pushes job branches to the
  enrolled repository itself, with no service forks (decided 2026-10-27, user).
- **Read-only CI, signed trust** (decided 2026-10-28, user, trust audit).
  Enrolled repositories keep pull-request CI read-only instead of kix
  shielding CI behind forks or per-push gates. Host trust comes from
  maintainer signatures or an explicit approval of the exact head, never from
  kix having published a commit. Landing needs a review of the exact head.
- **Ready means eligible.** After a maintainer opts in, ready quests on the
  default branch may be implemented. Draft plans are not eligible. Project
  pause stops new work. An explicit spawn decision can prioritize ready work
  without introducing another approval flag per quest.
- **Keep useful infrastructure.** Retain Workers/Hono and D1 for the web
  service. Durable database claims and live WebSocket connections to a
  per-owner Durable Object (decided 2026-10-16 on moq-dev/quest#135)
  replace MoQ locks and logs.
- **Not exclusive.** The web UI is one interface, not the only one. Every
  skill keeps working from a user's own agent (Claude Code, Codex, ...)
  without kix. The two coexist through GitHub: kix sees a local agent's
  quest branches and PRs, which count as claims and get the usual PR
  decision items. There is no plugin or session mirroring.
- **One owner per quest and PR** (decided 2026-10-20 from a transcript
  audit, see [quest start](https://github.com/moq-dev/quest/blob/d265755/quest/m0/helpers/start.md)). Claims are draft
  PRs. A PR is owned while it is a draft without a `## Decisions needed`
  section or carries one `quest:*` state label, shared with local sessions. There is no repository-wide merge agent and no user-facing
  parallelism limit; runner slots and account quota cap it.
- **Independent core.** Keep provider, GitHub, Cloudflare, and UI behavior
  outside the pure quest core. The standalone CLI and versioned quest
  format remain useful without this service.

The live rehearsal also covers what `quest runner` (`src/runner/`) could not
check locally (it shipped in
[moq-dev/quest#188](https://github.com/moq-dev/quest/pull/188)), and
fixes what it finds:

- On macOS, two accounts in separate `CLAUDE_CONFIG_DIR` homes keep separate
  Keychain credentials, and `claude auth status --json` reports each one's own
  `authMethod` and email.
- A rejected `rate_limit_event` and its `resetsAt` arrive when a plan runs
  out, so the account sits out until its reset instead of the one-hour
  fallback.
- opencode accounts (shipped with stubbed servers and a free model) sign in
  to an OpenCode Go plan and a ChatGPT plan, the latter through its headless
  method on a remote runner, and run a job on opencode's default model or
  `--model`. Their limits pause the account until the reset: OpenCode Go's
  `account_rate_limit` retry, and ChatGPT's `usage_limit_reached` error with
  `resets_at`. If ChatGPT plans fall short through opencode, plan the Codex
  adapter the 2026-10-15 decision allows.
- A merge job's publication refuses a merge commit that changes
  `.github/workflows` relative to the head it updates, which
  [moq-dev/quest#209](https://github.com/moq-dev/quest/pull/209) assumes
  is the comparison GitHub makes. Try it with a real PR that edits a
  workflow (decided 2026-10-24, user).

## Required

- [Deploy kix.quest](/quest/m0/kix/deploy.md) - the operator registers the App and deploys the Worker with GitHub sign-in at kix.quest
- [Read-only CI](/quest/m0/kix/ci-read-only.md) - enrolled repositories keep pull-request CI read-only, checked at enrollment, with every trust boundary written down
- [Operator setup](/quest/m0/kix/operator-setup.md) - pilot installations and a verified test PR on moq-dev/quest and moq-dev/moq
- [Pick repositories](/quest/m0/kix/pick-repos.md) - after installing, the maintainer enables repositories from a list
- [Setup PR](/quest/m0/kix/setup-pr.md) - enrolling a repository without Quest makes the App open its `quest init` pull request
- [Job sandbox](/quest/m0/kix/sandbox/README.md) - untrusted PR devShells built in a VM on Linux runners, maintainer PR heads trusted, opencode sandboxed, and macOS verified
- [Web execution](/quest/m0/kix/execution.md) - spawn and iterate through the UI, ending in contribution PRs
- [Land review](/quest/m0/kix/land-review.md) - kix lands only heads with a review that counts on that exact head
- [Onboarding guide](/quest/m0/kix/guide.md) - a complete maintainer path, from runner setup through a reviewed PR
- [Fast runner continuation test](/quest/m0/kix/runner-timeout.md) - the conflicted-continuation test passes on a loaded host without a longer timeout
