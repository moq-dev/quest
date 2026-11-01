# [L] Charge for cloud runner compute

## Goal

When free cloud capacity is not enough, a maintainer can pay for more cloud
runner compute and see what they were charged for. Model usage still comes
from their own connected accounts.

## Plan

- Decided 2026-10-15: start with free, operator-capped cloud compute; add
  billing only once usage justifies it.
- Open question: kix bills metered compute (for example Stripe), or users
  bring their own cloud account. Decide with the user when this starts.

## Required

- [Hosted runners](/quest/m2/cloud/runners.md) - the compute being billed
