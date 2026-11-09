# [S] Quests name the host they need

## Goal

A quest can name the operating systems it must run on, such as a
macOS-only camera check, in a field `quest check` validates.
`quest unblocked --json` reports it on each ready quest, so a dispatcher
routes work without reading prose, and a quest that names none runs anywhere.
The guide's Format section documents it.

## Plan

Decided 2026-11-08 in moq-dev/quest's `/quest-plan` ("OS gating: some jobs
need a particular OS... How does a worker know it can't take one?"):
✅ An explicit field (rejected: the agent judges when it claims). Confirmed
the same day in moq-dev/kixel.ai's factory plan, whose dispatch routes jobs
by it and starts with Linux and macOS runners only.

- Values: `linux`, `macos`, and `windows`. A section listing them, such as
  `## Hosts`, fits the format, which uses sections for everything else;
  settle the syntax before coding.
- No architecture or GPU values until a consumer needs one; moq-dev/moq's GPU
  runner quests are the likely first.

Tests: `quest check` rejects an unknown value and an empty field; `--json`
carries the field; a quest without one reports none.
