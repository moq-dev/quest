# [S] Open kix.quest

## Goal

The Worker serves `https://kix.quest` instead of `https://quest.moq.dev`, and
any owner who installs the App may enroll. The App's homepage, callback, and
webhook URLs, `cloudflare/wrangler.jsonc`'s route and `AUTH_URL`, `quest runner`'s
default `--url`, and the docs that name the live origin all name kix.quest,
and quest.moq.dev redirects there.

## Plan

Decided 2026-10-30 (user, /quest-plan): m0 hosts at quest.moq.dev and only
moq-dev may enroll, so nothing is spent making a public service before it
works for moq-dev. Decided 2026-11-03 (user, /quest-complete on
[moq-dev/quest#407](https://github.com/moq-dev/quest/pull/407)): the
kixelated user may enroll too. This quest undoes both for the launch.

- Remove the owner allowlist: the `ENROLL_OWNERS` Worker variable, its
  checks in `cloudflare/src/github/service.ts` and the webhook route, the
  "isn't open yet" copy on `/projects`, the dev and test fixtures' owner
  IDs, and its setup notes in `cloudflare/README.md` and
  `cloudflare/GITHUB.md` ("Owner allowlist").
- Keep the D1 database and secrets; only the origin changes. Existing
  sessions may be dropped.
- Comes before the landing page and launch material, which link kix.quest.

## Required

- [User state in their RunnerHub](/quest/m1/user-state.md) - its fresh start drops users' runners and jobs, which is safe only while enrollment is limited to the operator's own allowlisted owners
