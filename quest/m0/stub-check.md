# [S] Flag missing and outdated skill stubs

## Goal

A repository that uses Quest but lacks its skill stubs, or holds stubs an
older version wrote, is caught in two places. The SessionStart and
SubagentStart context `quest setup`'s hooks add tells the agent which stubs are
missing or outdated and to run `quest init` and land the result in a PR, and
`quest check` fails with the same list, so the repository's CI catches it too.
Nothing writes stubs on its own: `quest init` stays the only writer.

## Plan

Decided 2026-11-11 (maintainer, `/quest-plan`), after a repository that plans
in quests turned out to have no `/quest-*` skills, so an agent asked to go
unattended found no `/quest-afk`:

- **Where it is caught.** ✅ The session hooks' context and `quest check`
  (rejected: the hook running `quest init` itself, which leaves uncommitted
  stub files in every checkout an agent opens; a stderr warning on every
  command, which agents skim past and CI never fails on).
- **What counts.** ✅ Missing and outdated stubs (rejected: missing only).
  An outdated stub still works, but the maintainer wants each repository's
  stubs current. So a pin bump to a release whose stubs changed fails
  `quest check` until the same PR runs `quest init`: whatever bumps a
  repository's Quest pin, by hand or the maintainer's host watcher (planned in
  kixelated/nixos), runs `quest init` in that PR.
- **m0.** ✅ (rejected: m1).

Guidance, for the implementer to confirm:

- Reuse `planInit`: the stub changes it would make in the repository are
  exactly the missing and outdated stubs, so detection cannot drift from what
  `quest init` writes. Only stub changes count here; the reference line and
  the `.gitattributes` line are `quest init`'s other work, and `quest check`
  should flag them too only if that falls out of the same plan without new
  rules. An edited stub `quest init` refuses to rewrite is reported as such,
  not as outdated.
- "Outdated" is relative to the running `quest`. CI runs the repository's
  pinned build, so `quest check` there compares against the pin. The hooks run
  the user's global `quest`, which can be newer than the pin: name both
  versions in the hook's line so the agent bumps the pin with `quest init`
  rather than writing stubs the pinned build would call outdated.
- Keep the hook's addition to one short line, inside `CONTEXT_LIMIT`, and add
  nothing in a repository that does not use Quest (`usesQuest`).

Tests: a repository with no stubs, one with an older version's stub, one with
an edited stub, and one with current stubs; `quest check` fails, fails, reports
the edit, and passes, and the SessionStart and SubagentStart context carries
the line exactly when `quest check` would fail on stubs.
