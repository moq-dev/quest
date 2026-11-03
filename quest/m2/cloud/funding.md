# [L] Fund cloud runners with maintainer API keys

## Goal

A maintainer connects named API keys for providers the runner's adapters
support, selects the account that pays for a job, inspects attributed usage,
and pauses funding or revokes a key. A credential proxy keeps provider keys
outside runner containers and records concurrent requests in one durable
accounting ledger. This supplies the funding integration for the first
cloud runners; donor allocations follow working cloud runners separately.

## Plan

- Decided 2026-10-15 in the funding interview: implement maintainer API
  funding after the m0 runner, sandbox, and opencode adapter establish the
  execution boundary. Cloud runners then depend on this integration; funding
  does not depend on cloud runners. Verify it with stubbed runner requests
  before the hosted-container integration is available.
- Own-machine runners use their machine's own logins. Hosted API-key
  collection is an m1 cloud-runner capability, not an m0 onboarding step.
  Building and testing the funding integration does not enable production
  key collection before cloud runners launch.
- Store named account/key references per user so people with multiple
  accounts select the intended payer. Keep accounts distinct; one attempt
  uses one explicit account. Never silently switch keys or fall
  back to the maintainer's paid account when funding runs out.
- Planning and implementation use the maintainer's selected account.
  Attribute each charge once to its account, job, and attempt. Funding
  availability does not authorize planning or implementation by itself.
- Keep real provider keys outside untrusted runner containers. A constrained
  credential proxy authorizes each run's supported requests, routes them
  to the chosen account, and records usage. Use revocable job credentials
  inside executors rather than exposing the maintainer's key.
- Keep usage and request identities durable across concurrent requests,
  restarts, and uncertain outcomes. Stop new requests when funding is paused
  or revoked; in-flight requests may still finish and be billed. Donor budget
  reservations belong to the later allocations quest, on this same ledger.
- Be honest about estimates and in-flight costs. SDK `maxBudgetUsd` is a
  post-response threshold that can overshoot and resets across calls; it
  does not implement a shared monthly cap. Do not present it as one.
  Document provider workspace limits as an independent backstop.
- Hosting is paid by kix.quest under a separate operator limit until
  [paid compute](/quest/m2/cloud/billing.md) ships. API-key authorization
  never silently pays compute charges.
- Decided 2026-10-15: keep key setup, usage, pause/revocation, and deployment
  instructions in the existing service documentation. No separate guide
  quest is needed; update documentation made stale by implementation inline.
- Sources:
  [monthly credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans),
  [secure SDK deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment),
  [SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
  and [Console usage APIs](https://platform.claude.com/docs/en/manage-claude/usage-cost-api).

## Required

- [Job sandbox](/quest/m0/kix/sandbox/README.md) - the boundary keeping provider credentials outside job commands

## Related

- [Donor allocations](/quest/m2/cloud/donors.md) - add shared budgets after cloud runners work
