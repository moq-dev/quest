# [S] Allow only moq-dev to enroll

## Goal

Until the public release, only repositories whose owner is on an operator
allowlist can be enrolled on quest.moq.dev. Anyone else who signs in or
installs the App sees that kix isn't open yet, instead of an enrollment form,
and no job, webhook, or board runs for their repositories. The deployed
allowlist is `moq-dev`.

## Plan

Decided 2026-10-30 (user, /quest-plan): don't spend resources on a public
service before it works for moq-dev's own repositories.

- Who may enroll before the launch?
  - ✅ Only moq-dev
  - Anyone, with the host simply not advertised

- A Worker variable such as `ENROLL_OWNERS` in `cloudflare/wrangler.jsonc`
  holds a comma-separated list of GitHub owner IDs, with each owner's login
  in a comment beside it. Enrollment checks the repository owner's ID
  beside its existing checks; webhooks from other owners' installations are
  acknowledged and dropped. The local dev seed's owners are listed in dev.
- Store IDs, not logins resolved at read time: GitHub frees a deleted or
  renamed account's login for anyone to claim, so a name lookup could
  admit a different account.
- [Open kix.quest](/quest/m1/open.md) removes the allowlist for the launch.
- Test enrollment and a webhook for a listed and an unlisted owner.
