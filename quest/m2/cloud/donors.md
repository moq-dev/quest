# [L] Fund cloud runner jobs with donor allocations

## Goal

A donor authorizes a project/month budget or funds an individual quest
through a named API account, inspects usage, pauses funding, and revokes
their key. Concurrent cloud-runner jobs respect the same durable budgets
and charge only their explicitly selected allocation.

## Plan

- Decided 2026-10-15 in the funding interview: maintainer-funded cloud
  runners ship first. Donor allocations are an independently reviewable
  follow-up, so the first hosted jobs can establish the funding integration
  before adding shared-payer policy and budget enforcement.
- Extend the maintainer funding integration and its credential proxy and
  ledger. Keep named accounts distinct; one attempt uses one explicit
  account/allocation. Never silently switch keys or fall back to the
  maintainer's account when donor funding runs out.
- Donors explicitly permit planning, implementation, or both. A project
  planning allocation may fund an authorized interview before its new
  quests exist; implementation allocations apply only to eligible work.
  Funding never grants maintainer authority or authorizes a job by itself.
- Support project/month allocations and individual-quest allocations.
  Attribute each charge once to its allocation and any applicable
  donor-wide limit. A contribution is API-funded work, not transferred cash.
- Reserve against applicable budgets atomically before admitting requests;
  reconcile against returned usage and retain reservations for uncertain
  outcomes. Do not give concurrent workers separate copies of a balance.
  Stop new requests on exhaustion or revocation; in-flight requests may
  still finish and be billed. Keep provider keys outside runner containers.
- Be honest about estimates and in-flight costs. SDK `maxBudgetUsd` is a
  post-response threshold that can overshoot and resets across calls; it
  does not implement a shared monthly cap. Use it only as an additional
  control, with provider workspace limits as an independent backstop.
- Ordinary API keys have no documented promotional-balance or promo-only
  control. Anthropic spends promotional credits before purchased/invoiced
  funds. Do not advertise automatic harvesting of only unused credits, and
  do not ask for broad Admin API credentials to accept a donation.
- Hosted API-key use is documented; published credit terms do not
  explicitly approve this donation model. Separate verified API eligibility
  from assumptions about promotional funding; verify applicable provider
  terms before making public promotional-credit claims.
- Hosting stays under the operator's separate limit until
  [paid compute](/quest/m2/cloud/billing.md) ships. Donor API authorization
  never silently pays compute charges.
- Decided 2026-10-15: extend existing service documentation with donor
  consent, budget estimates, usage, exhaustion, and revocation behavior.
  No standalone guide quest is needed.
- Sources:
  [monthly credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans),
  [secure SDK deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment),
  [SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
  and [Console usage APIs](https://platform.claude.com/docs/en/manage-claude/usage-cost-api).

## Required

- [Hosted runners](/quest/m2/cloud/runners.md) - working cloud jobs using maintainer API funding

## Related

- [API funding](/quest/m2/cloud/funding.md) - the credential proxy and durable usage ledger
