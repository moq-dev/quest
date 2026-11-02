# [S] Open kix.quest

## Goal

The Worker serves `https://kix.quest` instead of `https://quest.moq.dev`, and
any owner who installs the App may enroll. The App's homepage, callback, and
webhook URLs, `cloudflare/wrangler.jsonc`'s route and `AUTH_URL`, and
`quest runner`'s default `--url` all name kix.quest, and quest.moq.dev
redirects there.

## Plan

Decided 2026-10-30 (user, /quest-plan): m0 hosts at quest.moq.dev and only
moq-dev may enroll, so nothing is spent making a public service before it
works for moq-dev. This quest undoes both for the launch.

- Remove the owner allowlist from
  [Owner allowlist](/quest/m0/kix/owners.md) and its setup notes.
- Keep the D1 database and secrets; only the origin changes. Existing
  sessions may be dropped.
- Comes before the landing page and launch material, which link kix.quest.
