# [M] A Claude session's checkout is released when the session ends

## Goal

A checkout `quest worktree hook` made for a Claude Code session itself (not
a subagent), through `--worktree`, `--bg`, or agent view, is released when
the session ends and claimed again when it resumes, so session checkouts no
longer pile up the way Claude Code's own do.

## Plan

Decided 2026-11-02 (coordinator, /quest-spawn follow-ups, after the user
asked the coordinator to decide follow-ups from evidence): plan it, [M], m0.

Evidence, gathered 2026-11-02:

- [moq-dev/quest#425](https://github.com/moq-dev/quest/pull/425)'s live
  probes found session checkouts never released by any route.
- Claude Code's own session worktrees (not `agent-*`) already accumulate:
  32 registered in moq.pro, 21 in moq, and 3 in quest (2026-10-14 to
  10-27), beside 449, 124, and 26 `agent-*` worktrees. Once the hooks own
  these checkouts the same backlog would build in the registry.

Work:

- Add `SessionEnd` and `SessionStart` entries to the opt-in user-level hook
  setup: the JSON block in the README's "Claude Code checkouts" section, which
  SETUP.md's "Opt into worktree hooks" step points to, and `HOOK_EVENTS` in
  `src/cli/worktree-hook.ts`. Amended 2026-11-03 (maintainer, /quest-unblock):
  `quest init` writes no hook entries anymore, so this quest no longer
  installs them through `init`.
- `SessionEnd` releases (never removes) the session's checkout;
  `SessionStart` claims it again on resume. `/clear` also fires
  `SessionEnd`, so release is idempotent and the next `SessionStart`
  reclaims it. An idle background session never ends; leave it held.
- Remote control's `bridge-*` checkouts are session checkouts too, and the
  release covers them if `SessionEnd` fires in a bridge-spawned session.
  [Remote control's live check](/quest/m0/worktree-routes.md) confirms
  whether it does. Release only prunes the declared scratch: it keeps every
  other file and Git's worktree lock (`release` and `prune` in
  `src/cli/worktree.ts`; only `remove` unlocks). The bridge still decides at
  session end, as that quest describes: it removes a clean checkout through
  `WorktreeRemove` and keeps one with changes. Verify that order in the same
  live check.
- Claude Code bounds `SessionEnd` hooks by a short budget
  (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`) and does not wait past it.
  Measure a release with scratch to delete, and set the entry's timeout to
  cover it. A release that fails or is cut short leaves the checkout
  reserved with its failure recorded, as `settle` does
  (`src/cli/worktree.ts`), and the next `SessionStart` for that session, or
  `quest worktree release` by hand, finishes it. Verify a killed release
  this way too.
- Verify each route live as #425 did, from a session that is not itself
  worktree-isolated.
