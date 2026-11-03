# [M] Donate independent agent reviews

## Goal

Projects can request API-funded reviews of a pinned PR head and receive
attributed GitHub review findings. Maintainers decide how to act on them.

## Plan

- Use the shared funding, executor, claims, and trusted publication boundaries.
  Review is an explicit funding purpose; existing implementation allocations
  do not silently expand to it.
- Findings name the reviewed head and become stale when it changes.
  A model's approval never bypasses required human reviews or protections.
- Do not automatically iterate or merge in response to a donated review.
  Present actionable findings through the decision inbox.
- Test head changes, duplicate publication, revoked funding, and unavailable
  repository tooling.

## Required

- [Web execution](/quest/m0/kix/execution.md) - the initial contribution flow
