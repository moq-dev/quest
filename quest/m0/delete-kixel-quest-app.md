# [XS] Delete the retired kixel-quest GitHub App

## Goal

The moq-dev-owned kixel-quest GitHub App (ID 5622964) is deleted, completing
kix's retirement. moq-bot remains the App used by the host's daemons.

## Plan

Decided 2026-11-08 (user): record the remaining App deletion as a follow-up
after browser automation could not connect. This belongs to m0's existing
decision to retire kix.

[moq-dev/quest#575](https://github.com/moq-dev/quest/pull/575) removed kix's
code. The quest-cloudflare Worker, quest-auth D1 database, and quest-output
R2 bucket were subsequently deleted; quest.moq.dev no longer resolved at
handoff. Only the GitHub App deletion remains.

In [moq-dev's GitHub App settings](https://github.com/organizations/moq-dev/settings/apps),
open kixel-quest, verify its App ID, and use Advanced to delete it. An agent
can drive the authenticated browser once access works. Verify the App is
absent from the organization's owned Apps, then remove this quest.

## Waiting

- Maintainer: reconnect an authenticated Chrome session for agent control,
  or delete the App directly. The Chrome MCP repeatedly returned "The browser
  access host is unavailable"; the T3 browser reached GitHub's sign-in page.
  No API deletion route was identified. Clear this wait when browser access
  works or the App's absence is verified in moq-dev's owned Apps.
